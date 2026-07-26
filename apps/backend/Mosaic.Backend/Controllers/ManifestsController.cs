using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/v1/manifests")]
public class ManifestsController : ControllerBase
{
    /// <summary>
    /// Hard cap on tiered shards per finalize request. 1024 = 256 photos worth of
    /// shards at 4 tiers, far above any realistic single-finalize payload while
    /// preventing 1M-element DoS payloads from exhausting validation memory.
    /// (v1.0.1 s19.)
    /// </summary>
    private const int MAX_TIERED_SHARDS_COUNT = 1024;

    private readonly MosaicDbContext _db;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ICurrentUserService _currentUserService;
    private readonly ILogger<ManifestsController> _logger;
    private readonly IAlbumExpirationService _expirationService;
    private readonly TimeProvider _timeProvider;
    private readonly IStorageService? _storageService;

    public ManifestsController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService,
        ICurrentUserService currentUserService,
        ILogger<ManifestsController> logger,
        IAlbumExpirationService? expirationService = null,
        TimeProvider? timeProvider = null,
        IStorageService? storageService = null)
    {
        _db = db;
        _quotaService = quotaService;
        _currentUserService = currentUserService;
        _logger = logger;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _storageService = storageService;
        _expirationService = expirationService ?? new AlbumExpirationService(
            db,
            _timeProvider,
            NullLogger<AlbumExpirationService>.Instance);

    }



    [HttpPost("sequence-reservations")]
    [ProducesResponseType<ManifestSequenceReservationResponse>(StatusCodes.Status200OK)]
    public async Task<IActionResult> ReserveSequence([FromBody] ReserveManifestSequenceRequest request)
    {
        if (!ManifestSequenceOperations.IsSupported(request.OperationKind))
        {
            return Problem(
                detail: "operationKind must be Create, MetadataUpdate, or Tombstone",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.TargetManifestId == Guid.Empty || request.OperationId == Guid.Empty)
        {
            return Problem(
                detail: "targetManifestId and operationId must be non-empty UUIDs",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (!TryDecodeBase64(request.SignerPubkey, out var signerPubkeyBytes) || signerPubkeyBytes.Length != 32)
        {
            return Problem(
                detail: "signerPubkey must be valid base64 and exactly 32 bytes",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var canonicalSignerPubkey = Convert.ToBase64String(signerPubkeyBytes);
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            Album? album;
            if (_db.UsesLiteProvider())
            {
                album = await _db.Albums.FindAsync(request.AlbumId);
            }
            else
            {
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", request.AlbumId)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return NotFound();
            }

            var (_, memberError) = await _db.RequireAlbumEditorAsync(album.Id, user.Id);
            if (memberError != null)
            {
                return memberError;
            }

            if (_expirationService.IsExpired(album.ExpiresAt))
            {
                return StatusCode(StatusCodes.Status410Gone);
            }

            var signerEpochId = await _db.EpochKeys
                .Where(key => key.AlbumId == album.Id && key.SignPubkey == signerPubkeyBytes)
                .Select(key => (int?)key.EpochId)
                .FirstOrDefaultAsync();
            if (!signerEpochId.HasValue)
            {
                return Problem(
                    detail: "signerPubkey does not identify an epoch key for this album",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (signerEpochId.Value != album.CurrentEpochId)
            {
                return Problem(
                    detail: "sequence reservations require the current album epoch signer",
                    statusCode: StatusCodes.Status409Conflict);
            }

            var existing = await _db.ManifestSequenceReservations
                .FirstOrDefaultAsync(reservation => reservation.OperationId == request.OperationId);
            if (existing != null)
            {
                if (existing.AlbumId != album.Id
                    || existing.TargetManifestId != request.TargetManifestId
                    || existing.OperationKind != request.OperationKind
                    || existing.SignerPubkey != canonicalSignerPubkey)
                {
                    return Problem(
                        detail: "operationId is already bound to a different sequence reservation",
                        statusCode: StatusCodes.Status409Conflict);
                }

                var existingState = await GetOrCreateSequenceStateAsync(
                    album.Id,
                    canonicalSignerPubkey);
                if (!existing.ConsumedAt.HasValue
                    && existing.ManifestSeq <= existingState.LastConsumedSequence)
                {
                    if (existingState.LastAllocatedSequence == long.MaxValue)
                    {
                        return Problem(
                            detail: "manifest sequence space is exhausted for this signer",
                            statusCode: StatusCodes.Status409Conflict);
                    }

                    existingState.LastAllocatedSequence++;
                    existing.ManifestSeq = existingState.LastAllocatedSequence;
                    existing.CreatedAt = _timeProvider.GetUtcNow().UtcDateTime;
                }

                // SaveChanges also persists a defensively reconstructed state
                // row. For a non-stale retry it leaves the reservation intact.
                await _db.SaveChangesAsync();
                await tx.CommitAsync();
                return Ok(new ManifestSequenceReservationResponse(existing.Id, existing.ManifestSeq));
            }

            var targetExists = await _db.Manifests
                .IgnoreQueryFilters()
                .AnyAsync(manifest => manifest.Id == request.TargetManifestId && manifest.AlbumId == album.Id);
            if (request.OperationKind == ManifestSequenceOperations.Create && targetExists)
            {
                return Problem(
                    detail: "target manifest already exists",
                    statusCode: StatusCodes.Status409Conflict);
            }
            if (request.OperationKind != ManifestSequenceOperations.Create && !targetExists)
            {
                return Problem(
                    detail: "target manifest does not exist in this album",
                    statusCode: StatusCodes.Status404NotFound);
            }

            var state = await GetOrCreateSequenceStateAsync(album.Id, canonicalSignerPubkey);

            if (state.LastAllocatedSequence == long.MaxValue)
            {
                return Problem(
                    detail: "manifest sequence space is exhausted for this signer",
                    statusCode: StatusCodes.Status409Conflict);
            }

            var nextSequence = state.LastAllocatedSequence + 1;
            state.LastAllocatedSequence = nextSequence;
            var reservation = new ManifestSequenceReservation
            {
                Id = Guid.CreateVersion7(),
                AlbumId = album.Id,
                SignerPubkey = canonicalSignerPubkey,
                TargetManifestId = request.TargetManifestId,
                OperationId = request.OperationId,
                OperationKind = request.OperationKind,
                ManifestSeq = nextSequence,
                CreatedAt = _timeProvider.GetUtcNow().UtcDateTime
            };
            _db.ManifestSequenceReservations.Add(reservation);
            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return Ok(new ManifestSequenceReservationResponse(reservation.Id, reservation.ManifestSeq));
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Legacy direct-call adapter retained only for existing in-process tests.
    /// It is deliberately not an MVC action: production clients must choose a
    /// manifest ID, reserve a v2 sequence, sign it, and call /{id}/finalize.
    /// </summary>
    [NonAction]
    public Task<IActionResult> Create([FromBody] CreateManifestRequest request)
        => FinalizeManifestCoreAsync(Guid.CreateVersion7(), request, requireSequenceReservation: false);

    /// <summary>
    /// Finalize a client-addressed manifest id using the ADR-022 v1 shape.
    /// </summary>
    /// <param name="manifestId">Client-selected manifest ID.</param>
    /// <param name="request">The signed manifest and reserved sequence.</param>
    /// <param name="idempotencyKey">Optional replay-cache key. Reuse it only for the same payload. Finalization is also intrinsically retry-safe by manifest ID: an exact retry returns the original 201 response and a changed payload returns 409.</param>
    [HttpPost("{manifestId:guid}/finalize")]
    [ProducesResponseType<ManifestFinalizeResponse>(StatusCodes.Status201Created)]
    public Task<IActionResult> Finalize(
        Guid manifestId,
        [FromBody] CreateManifestRequest request,
        [FromHeader(Name = IdempotencyMiddleware.HeaderName), MaxLength(IdempotencyMiddleware.MaxKeyLength)] string? idempotencyKey = null)
        => FinalizeManifestCoreAsync(manifestId, request, requireSequenceReservation: true);

    private async Task<IActionResult> FinalizeManifestCoreAsync(
        Guid manifestId,
        CreateManifestRequest request,
        bool requireSequenceReservation)
    {
        var validationError = ValidateFinalizeRequest(request);
        if (validationError != null)
        {
            return validationError;
        }

        if (requireSequenceReservation
            && (!request.ManifestSeq.HasValue || !request.SequenceReservationId.HasValue))
        {
            return Problem(
                detail: "manifestSeq and sequenceReservationId are required for v2 manifest finalization",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (requireSequenceReservation && request.ManifestSeq <= 0)
        {
            return Problem(
                detail: "manifestSeq must be a positive integer",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (requireSequenceReservation && request.ExpiresAt.HasValue)
        {
            return Problem(
                detail: "Per-photo expiration is deferred until the signed v2 manifest lifecycle supports it",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var finalizeRequestHash = ComputeFinalizeRequestHash(manifestId, request);
        var shardInfoList = request.TieredShards!
            .Select(tieredShard => (
                Id: Guid.Parse(tieredShard.ShardId),
                tieredShard.Tier,
                tieredShard.ShardIndex,
                tieredShard.Sha256,
                tieredShard.ContentLength,
                tieredShard.EnvelopeVersion))
            .OrderBy(shard => shard.Tier)
            .ThenBy(shard => shard.ShardIndex)
            .ToList();
        var shardGuids = shardInfoList.Select(s => s.Id).ToList();

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            Album? album;
            if (_db.UsesLiteProvider())
            {
                album = await _db.Albums.FindAsync(request.AlbumId);
            }
            else
            {
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", request.AlbumId)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return Problem(
                    detail: "Album not found",
                    statusCode: StatusCodes.Status404NotFound);
            }

            var (_, memberError) = await _db.RequireAlbumEditorAsync(album.Id, user.Id);
            if (memberError != null)
            {
                return memberError;
            }

            if (!TryDecodeBase64(request.SignerPubkey, out var signerPubkeyBytesForEpochLookup)
                || signerPubkeyBytesForEpochLookup.Length != 32)
            {
                return Problem(
                    detail: "signerPubkey must be valid base64 and exactly 32 bytes",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var canonicalSignerPubkey = Convert.ToBase64String(signerPubkeyBytesForEpochLookup);
            var existingManifest = await _db.Manifests
                .IgnoreQueryFilters()
                .Include(manifest => manifest.ManifestShards)
                .FirstOrDefaultAsync(manifest => manifest.Id == manifestId);
            if (existingManifest != null)
            {
                ManifestSequenceReservation? reservation = null;
                if (request.SequenceReservationId.HasValue)
                {
                    reservation = await _db.ManifestSequenceReservations
                        .AsNoTracking()
                        .FirstOrDefaultAsync(candidate => candidate.Id == request.SequenceReservationId.Value);
                }

                if (requireSequenceReservation
                    && IsExactFinalizeReplay(
                        existingManifest,
                        reservation,
                        request,
                        canonicalSignerPubkey,
                        finalizeRequestHash))
                {
                    var storedShardInfo = existingManifest.ManifestShards
                        .Select(link => (
                            Id: link.ShardId,
                            Tier: link.Tier,
                            ShardIndex: link.ShardIndex,
                            Sha256: (string?)link.Sha256,
                            ContentLength: (long?)link.ContentLength,
                            EnvelopeVersion: link.EnvelopeVersion))
                        .ToList();

                    await tx.CommitAsync();
                    Response.Headers["Idempotency-Replayed"] = "true";
                    SetManifestETag(existingManifest.FinalizeMetadataVersion ?? 1);
                    return Created(
                        $"/api/v1/manifests/{existingManifest.Id}",
                        ToFinalizeResponse(
                            existingManifest,
                            storedShardInfo,
                            existingManifest.FinalizeMetadataVersion ?? 1));
                }

                return Conflict(new
                {
                    error = "Manifest already finalized",
                    detail = "The supplied manifest id is bound to a different finalize request or sequence reservation.",
                    manifestId
                });
            }

            if (requireSequenceReservation && _storageService == null)
            {
                _logger.LogCritical("Manifest finalization storage verification is unavailable");
                return Problem(
                    detail: "Shard storage verification is unavailable",
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            if (_expirationService.IsExpired(album.ExpiresAt))
            {
                await _expirationService.EnforceAlbumExpirationAsync(album.Id);
                return StatusCode(StatusCodes.Status410Gone);
            }

            if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= _timeProvider.GetUtcNow())
            {
                return Problem(
                    detail: "expiresAt must be in the future",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var manifestEpochId = await _db.EpochKeys
                .Where(ek => ek.AlbumId == album.Id && ek.SignPubkey == signerPubkeyBytesForEpochLookup)
                .Select(ek => (int?)ek.EpochId)
                .FirstOrDefaultAsync();
            if (!manifestEpochId.HasValue)
            {
                return Problem(
                    detail: "Manifest signed by an unknown epoch key for this album",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (manifestEpochId.Value != album.CurrentEpochId)
            {
                return Problem(
                    detail: "Manifest signer is not the current album epoch",
                    statusCode: StatusCodes.Status409Conflict);
            }

            if (!requireSequenceReservation && request.ManifestSeq.HasValue)
            {
                var maxSeqForEpoch = await _db.Manifests
                    .IgnoreQueryFilters()
                    .Where(m => m.AlbumId == album.Id
                        && m.SignerPubkey == canonicalSignerPubkey
                        && m.ManifestSeq != null)
                    .MaxAsync(m => (long?)m.ManifestSeq) ?? 0L;
                if (request.ManifestSeq.Value <= maxSeqForEpoch)
                {
                    return Problem(
                        detail: "Manifest sequence is not strictly greater than the current signer maximum",
                        statusCode: StatusCodes.Status409Conflict);
                }
            }

            var shards = await _db.Shards
                .Where(s => shardGuids.Contains(s.Id))
                .ToListAsync();

            if (shards.Count != shardGuids.Count)
            {
                _logger.LogWarning("Shards not found: requested {Requested}, found {Found}. Missing: {Missing}",
                    shardGuids.Count, shards.Count,
                    string.Join(",", shardGuids.Except(shards.Select(s => s.Id))));
                return Problem(
                    detail: "Some shards not found",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (shards.Any(s => s.UploaderId != user.Id))
            {
                _logger.LogWarning("Shard ownership mismatch for user {UserId}", user.Id);
                return Forbid();
            }

            if (shards.Any(s => s.Status != ShardStatus.PENDING))
            {
                return Problem(
                    detail: "Some shards already linked to a manifest",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var shardFileIds = shardGuids.Select(id => id.ToString()).ToList();
            var nonFinalisableUploadIds = await _db.TusUploadLifecycles
                .Where(l => shardFileIds.Contains(l.FileId) && l.State != TusUploadLifecycleState.COMMITTED)
                .Select(l => l.FileId)
                .ToListAsync();
            if (nonFinalisableUploadIds.Count > 0)
            {
                _logger.LogError(
                    "Manifest {ManifestId} references non-committed or quarantined Tus uploads: {FileIds}",
                    manifestId,
                    string.Join(",", nonFinalisableUploadIds));
                return Problem(
                    detail: "Some shards have not reached a committed upload lifecycle",
                    statusCode: StatusCodes.Status409Conflict);
            }

            if (_storageService != null)
            {
                var unreadableShardFileIds = new List<string>();
                foreach (var shard in shards)
                {
                    try
                    {
                        await using var blob = await _storageService.OpenReadAsync(shard.StorageKey);
                        if (!blob.CanRead)
                        {
                            unreadableShardFileIds.Add(shard.Id.ToString());
                        }
                    }
                    catch (Exception ex) when (ex is ShardMissingException
                        or IOException
                        or UnauthorizedAccessException
                        or ArgumentException)
                    {
                        unreadableShardFileIds.Add(shard.Id.ToString());
                        _logger.LogError(
                            ex,
                            "Manifest {ManifestId} cannot activate shard {ShardId}: backing blob {StorageKey} is unreadable",
                            manifestId,
                            shard.Id,
                            shard.StorageKey);
                    }
                }

                if (unreadableShardFileIds.Count > 0)
                {
                    var quarantineNow = _timeProvider.GetUtcNow().UtcDateTime;
                    var lifecycles = await _db.TusUploadLifecycles
                        .Where(l => unreadableShardFileIds.Contains(l.FileId))
                        .ToListAsync();
                    foreach (var lifecycle in lifecycles)
                    {
                        lifecycle.State = TusUploadLifecycleState.QUARANTINED;
                        lifecycle.UpdatedAt = quarantineNow;
                        lifecycle.QuarantinedAt = quarantineNow;
                        lifecycle.QuarantineReason = "manifest-finalization-blob-unreadable";
                    }
                    await _db.SaveChangesAsync();
                    await tx.CommitAsync();

                    _logger.LogCritical(
                        "Manifest {ManifestId} activation blocked because shard blobs are unreadable: {FileIds}",
                        manifestId,
                        string.Join(",", unreadableShardFileIds));
                    return Problem(
                        detail: "Some shard blobs are missing or unreadable; the uploads were quarantined",
                        statusCode: StatusCodes.Status409Conflict);
                }
            }

            foreach (var shardInfo in shardInfoList)
            {
                var shard = shards.Single(s => s.Id == shardInfo.Id);
                if (shardInfo.Sha256 != null && !string.Equals(shard.Sha256, shardInfo.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    return Problem(
                        detail: "tieredShards sha256 does not match stored shard hash",
                        statusCode: StatusCodes.Status400BadRequest);
                }

                if (shardInfo.ContentLength.HasValue && shard.SizeBytes != shardInfo.ContentLength.Value)
                {
                    return Problem(
                        detail: "tieredShards contentLength does not match stored shard length",
                        statusCode: StatusCodes.Status400BadRequest);
                }

                if (shard.EnvelopeVersion.HasValue && shard.EnvelopeVersion.Value != shardInfo.EnvelopeVersion)
                {
                    return Problem(
                        detail: "tieredShards envelopeVersion does not match authenticated upload metadata",
                        statusCode: StatusCodes.Status400BadRequest);
                }
            }

            var albumLimits = await _db.AlbumLimits.FindAsync(album.Id);
            var maxPhotos = await _quotaService.GetEffectiveMaxPhotosAsync(album.Id);
            var maxSize = await _quotaService.GetEffectiveMaxAlbumSizeAsync(album.Id);
            var shardsTotalSize = shards.Sum(s => s.SizeBytes);

            var currentPhotoCount = albumLimits?.CurrentPhotoCount ?? 0;
            var currentSizeBytes = albumLimits?.CurrentSizeBytes ?? 0;

            if (currentPhotoCount >= maxPhotos)
            {
                _logger.PhotoCountLimitExceeded(album.Id, currentPhotoCount, maxPhotos);
                return Problem(
                    detail: $"ALBUM_PHOTOS_EXCEEDED: Album photo limit ({maxPhotos}) reached",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (currentSizeBytes + shardsTotalSize > maxSize)
            {
                _logger.PhotoSizeLimitExceeded(album.Id, currentSizeBytes + shardsTotalSize, maxSize);
                return Problem(
                    detail: "ALBUM_SIZE_EXCEEDED: Album size limit exceeded",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            // Consume only after every retryable integrity/quota validation has
            // passed. From this point the sequence watermark, reservation,
            // manifest, album cursor, shards, and limits commit atomically.
            if (requireSequenceReservation)
            {
                var sequenceError = await ConsumeSequenceReservationAsync(
                    album.Id,
                    canonicalSignerPubkey,
                    manifestId,
                    ManifestSequenceOperations.Create,
                    request.SequenceReservationId,
                    request.ManifestSeq);
                if (sequenceError != null)
                {
                    return sequenceError;
                }
            }

            var now = DateTimeOffset.UtcNow;
            album.CurrentVersion++;
            album.UpdatedAt = now.UtcDateTime;

            var manifest = new Manifest
            {
                Id = manifestId,
                AlbumId = album.Id,
                ProtocolVersion = request.ProtocolVersion,
                AssetType = request.AssetType,
                VersionCreated = album.CurrentVersion,
                MetadataVersion = 1,
                EncryptedMeta = request.EncryptedMeta,
                EncryptedMetaSidecar = request.EncryptedMetaSidecar,
                Signature = request.Signature,
                SignerPubkey = canonicalSignerPubkey,
                FinalizeRequestHash = finalizeRequestHash,
                FinalizeMetadataVersion = 1,
                ExpiresAt = request.ExpiresAt,
                ManifestSeq = request.ManifestSeq,
                CreatedAt = now.UtcDateTime,
                UpdatedAt = now.UtcDateTime
            };
            _db.Manifests.Add(manifest);

            for (var i = 0; i < shardInfoList.Count; i++)
            {
                var shardInfo = shardInfoList[i];
                var shard = shards.Single(s => s.Id == shardInfo.Id);
                shard.Status = ShardStatus.ACTIVE;
                shard.StatusUpdatedAt = now.UtcDateTime;
                shard.PendingExpiresAt = null;

                _db.ManifestShards.Add(new ManifestShard
                {
                    ManifestId = manifest.Id,
                    ShardId = shard.Id,
                    ChunkIndex = i,
                    Tier = shardInfo.Tier,
                    ShardIndex = shardInfo.ShardIndex,
                    Sha256 = shardInfo.Sha256 ?? shard.Sha256 ?? string.Empty,
                    ContentLength = shardInfo.ContentLength ?? shard.SizeBytes,
                    EnvelopeVersion = shardInfo.EnvelopeVersion
                });
            }

            if (albumLimits != null)
            {
                albumLimits.CurrentPhotoCount++;
                albumLimits.CurrentSizeBytes += shardsTotalSize;
                albumLimits.UpdatedAt = now.UtcDateTime;
            }
            else
            {
                _db.AlbumLimits.Add(new AlbumLimits
                {
                    AlbumId = album.Id,
                    CurrentPhotoCount = 1,
                    CurrentSizeBytes = shardsTotalSize
                });
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            SetManifestETag(manifest);
            return Created($"/api/v1/manifests/{manifest.Id}", ToFinalizeResponse(manifest, shardInfoList));
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    private static bool IsExactFinalizeReplay(
        Manifest manifest,
        ManifestSequenceReservation? reservation,
        CreateManifestRequest request,
        string canonicalSignerPubkey,
        byte[] requestHash)
    {
        if (manifest.IsDeleted
            || manifest.FinalizeRequestHash == null
            || manifest.FinalizeRequestHash.Length != requestHash.Length
            || !CryptographicOperations.FixedTimeEquals(manifest.FinalizeRequestHash, requestHash))
        {
            return false;
        }

        return manifest.AlbumId == request.AlbumId
            && manifest.ProtocolVersion == request.ProtocolVersion
            && reservation != null
            && reservation.Id == request.SequenceReservationId
            && reservation.AlbumId == request.AlbumId
            && reservation.TargetManifestId == manifest.Id
            && reservation.OperationKind == ManifestSequenceOperations.Create
            && reservation.SignerPubkey == canonicalSignerPubkey
            && reservation.ManifestSeq == request.ManifestSeq
            && reservation.ConsumedAt.HasValue;
    }

    private static byte[] ComputeFinalizeRequestHash(Guid manifestId, CreateManifestRequest request)
    {
        // This fingerprint is stored in the same transaction as the manifest.
        // It closes the middleware/domain split-commit window without storing
        // plaintext metadata: the input is already opaque ciphertext and the
        // persisted value is a one-way SHA-256 digest.
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("Mosaic_Finalize_Request_v1"u8);
        hash.AppendData(manifestId.ToByteArray());
        hash.AppendData(JsonSerializer.SerializeToUtf8Bytes(request));
        return hash.GetHashAndReset();
    }

    private IActionResult? ValidateFinalizeRequest(CreateManifestRequest request)
    {
        if (request.ProtocolVersion != 1)
        {
            return Problem(
                detail: "protocolVersion must be 1",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (!IsSupportedAssetType(request.AssetType))
        {
            return Problem(
                detail: "assetType must be Image, Video, or LiveImage",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.TieredShards == null || request.TieredShards.Count == 0)
        {
            return Problem(
                detail: "tieredShards is required for manifest finalization",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.TieredShards.Count > MAX_TIERED_SHARDS_COUNT)
        {
            return Problem(
                detail: $"tieredShards count must not exceed {MAX_TIERED_SHARDS_COUNT}",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var seen = new HashSet<(int Tier, int ShardIndex)>();
        foreach (var tieredShard in request.TieredShards)
        {
            if (!Guid.TryParse(tieredShard.ShardId, out _))
            {
                return Problem(
                    detail: $"Invalid shard ID format: {tieredShard.ShardId}",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (!Enum.IsDefined(typeof(ShardTier), tieredShard.Tier))
            {
                return Problem(
                    detail: "tieredShards tier must be 1, 2, or 3",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (tieredShard.ShardIndex < 0)
            {
                return Problem(
                    detail: "tieredShards shardIndex must be non-negative",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (!seen.Add((tieredShard.Tier, tieredShard.ShardIndex)))
            {
                return Problem(
                    detail: "tieredShards shardIndex must be unique per tier",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (tieredShard.Sha256 != null && !IsLowercaseSha256Hex(tieredShard.Sha256))
            {
                return Problem(
                    detail: "tieredShards sha256 must be lowercase hex SHA-256",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (tieredShard.ContentLength is <= 0)
            {
                return Problem(
                    detail: "tieredShards contentLength must be positive",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (!ManifestEnvelopeVersions.IsSupported(tieredShard.EnvelopeVersion))
            {
                return Problem(
                    detail: "tieredShards envelopeVersion must be 3 or 4",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }

        foreach (var tierGroup in request.TieredShards.GroupBy(shard => shard.Tier))
        {
            var indices = tierGroup.Select(shard => shard.ShardIndex).Order().ToArray();
            for (var expected = 0; expected < indices.Length; expected++)
            {
                if (indices[expected] != expected)
                {
                    return Problem(
                        detail: "tieredShards shardIndex must be contiguous per tier",
                        statusCode: StatusCodes.Status400BadRequest);
                }
            }
        }

        return null;
    }

    private static bool IsSupportedAssetType(string assetType)
        => string.Equals(assetType, "Image", StringComparison.Ordinal)
            || string.Equals(assetType, "Video", StringComparison.Ordinal)
            || string.Equals(assetType, "LiveImage", StringComparison.Ordinal);

    private static bool IsLowercaseSha256Hex(string? value)
        => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static ManifestFinalizeResponse ToFinalizeResponse(
        Manifest manifest,
        IReadOnlyCollection<(Guid Id, int Tier, int ShardIndex, string? Sha256, long? ContentLength, int EnvelopeVersion)> shardInfoList,
        long? metadataVersion = null)
        => new()
        {
            ProtocolVersion = manifest.ProtocolVersion,
            ManifestId = manifest.Id,
            MetadataVersion = metadataVersion ?? manifest.MetadataVersion,
            CreatedAt = manifest.CreatedAt,
            TieredShards = shardInfoList
                .OrderBy(shard => shard.Tier)
                .ThenBy(shard => shard.ShardIndex)
                .Select(shard => new TieredShardInfo(
                    shard.Id.ToString(),
                    shard.Tier,
                    shard.ShardIndex,
                    shard.Sha256 ?? string.Empty,
                    shard.ContentLength ?? 0,
                    shard.EnvelopeVersion))
                .ToList()
        };

    /// <summary>
    /// Update encrypted metadata for an existing manifest without changing shard references.
    /// </summary>
    [NonAction]
    public Task<IActionResult> UpdateMetadata(Guid manifestId, [FromBody] UpdateManifestMetadataRequest request)
        => UpdateMetadataCoreAsync(manifestId, request, requireSequenceReservation: false);

    [HttpPatch("{manifestId:guid}/metadata")]
    [ProducesResponseType<ManifestMetadataUpdateResponse>(StatusCodes.Status200OK)]
    public Task<IActionResult> UpdateMetadataV2(Guid manifestId, [FromBody] UpdateManifestMetadataRequest request)
        => UpdateMetadataCoreAsync(manifestId, request, requireSequenceReservation: true);

    private async Task<IActionResult> UpdateMetadataCoreAsync(
        Guid manifestId,
        UpdateManifestMetadataRequest request,
        bool requireSequenceReservation)
    {
        if (requireSequenceReservation
            && (!request.ManifestSeq.HasValue
                || request.ManifestSeq.Value <= 0
                || !request.SequenceReservationId.HasValue))
        {
            return Problem(
                detail: "manifestSeq and sequenceReservationId are required for v2 metadata updates",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // Resolve only the immutable parent key before acquiring the
            // serialization lock. Tracking the manifest before FOR UPDATE
            // would leave this transaction with stale metadata after waiting
            // for a concurrent mutation to commit.
            var albumId = await _db.Manifests
                .IgnoreQueryFilters()
                .AsNoTracking()
                .Where(candidate => candidate.Id == manifestId && !candidate.IsDeleted)
                .Select(candidate => (Guid?)candidate.AlbumId)
                .FirstOrDefaultAsync();
            if (!albumId.HasValue)
            {
                return NotFound();
            }

            // All signed manifest mutations serialize on the album row.
            Album? album;
            if (_db.UsesLiteProvider())
            {
                album = await _db.Albums.FindAsync(albumId.Value);
            }
            else
            {
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", albumId.Value)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return NotFound();
            }

            // READ COMMITTED takes a fresh snapshot for this statement after
            // the lock wait, so validation and mutation use the latest row.
            var manifest = await _db.Manifests
                .IgnoreQueryFilters()
                .FirstOrDefaultAsync(candidate => candidate.Id == manifestId);
            if (manifest == null || manifest.IsDeleted)
            {
                return NotFound();
            }

            var (_, memberError) = await _db.RequireAlbumEditorAsync(album.Id, user.Id, new NotFoundResult());
            if (memberError != null)
            {
                return memberError;
            }

            if (_expirationService.IsExpired(album.ExpiresAt))
            {
                await _expirationService.EnforceAlbumExpirationAsync(album.Id);
                return StatusCode(StatusCodes.Status410Gone);
            }

            var ifMatchError = ValidateIfMatchOrWarn(manifest, "metadata");
            if (ifMatchError != null)
            {
                return ifMatchError;
            }

            if (!TryDecodeBase64(request.EncryptedMeta, out var encryptedMeta) || encryptedMeta.Length < 16)
            {
                return Problem(
                    detail: "encryptedMeta must be valid base64 and at least 16 bytes",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (!TryDecodeBase64(request.Signature, out var signatureBytes) || signatureBytes.Length == 0)
            {
                return Problem(
                    detail: "signature must be valid base64 and non-empty",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (!TryDecodeBase64(request.SignerPubkey, out var signerPubkeyBytes) || signerPubkeyBytes.Length != 32)
            {
                return Problem(
                    detail: "signerPubkey must be valid base64 and exactly 32 bytes",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var activeEpochSignPubkeys = await _db.EpochKeys
                .Join(
                    _db.AlbumMembers,
                    ek => new { ek.AlbumId, UserId = ek.RecipientId },
                    am => new { am.AlbumId, am.UserId },
                    (ek, am) => new { EpochKey = ek, Member = am })
                .Where(x => x.EpochKey.AlbumId == album.Id && x.Member.RevokedAt == null)
                .Select(x => x.EpochKey.SignPubkey)
                .ToListAsync();

            if (!activeEpochSignPubkeys.Any(pubkey => pubkey.AsSpan().SequenceEqual(signerPubkeyBytes)))
            {
                return Problem(
                    detail: "signerPubkey does not match any active epoch sign key for this album",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var canonicalSignerPubkey = Convert.ToBase64String(signerPubkeyBytes);
            if (requireSequenceReservation)
            {
                var isCurrentEpochSigner = await _db.EpochKeys.AnyAsync(key =>
                    key.AlbumId == album.Id
                    && key.EpochId == album.CurrentEpochId
                    && key.SignPubkey == signerPubkeyBytes);
                if (!isCurrentEpochSigner)
                {
                    return Problem(
                        detail: "metadata updates require the current album epoch signer",
                        statusCode: StatusCodes.Status409Conflict);
                }

                var sequenceError = await ConsumeSequenceReservationAsync(
                    album.Id,
                    canonicalSignerPubkey,
                    manifest.Id,
                    ManifestSequenceOperations.MetadataUpdate,
                    request.SequenceReservationId,
                    request.ManifestSeq);
                if (sequenceError != null)
                {
                    return sequenceError;
                }
            }

            manifest.EncryptedMeta = encryptedMeta;
            manifest.Signature = request.Signature;
            manifest.SignerPubkey = canonicalSignerPubkey;
            if (requireSequenceReservation)
            {
                manifest.ManifestSeq = request.ManifestSeq;
            }
            manifest.VersionCreated = album.CurrentVersion + 1;
            manifest.MetadataVersion++;
            manifest.UpdatedAt = DateTime.UtcNow;
            album.CurrentVersion++;
            album.UpdatedAt = DateTime.UtcNow;

            await _db.SaveChangesAsync();
            await tx.CommitAsync();
            SetManifestETag(manifest);

            _logger.LogInformation(
                "Manifest {ManifestId} metadata updated by {UserId}, new version {Version}",
                manifest.Id,
                user.Id,
                manifest.VersionCreated);

            return Ok(new ManifestMetadataUpdateResponse(manifest.Id, manifest.VersionCreated));
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Legacy in-process photo-expiration adapter. Deliberately not routable:
    /// advancing a manifest sync cursor without a fresh v2 signed sequence can
    /// make a valid older row fail global replay checks. Restore a public route
    /// only with a reservation-backed signed producer.
    /// </summary>
    [NonAction]
    public async Task<IActionResult> UpdateExpiration(Guid manifestId, [FromBody] UpdateManifestExpirationRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var manifest = await _db.Manifests
            .IgnoreQueryFilters()
            .Include(m => m.Album)
            .FirstOrDefaultAsync(m => m.Id == manifestId);

        if (manifest == null || manifest.IsDeleted)
        {
            return NotFound();
        }

        var (_, memberError) = await _db.RequireAlbumEditorAsync(manifest.AlbumId, user.Id, new NotFoundResult());
        if (memberError != null)
        {
            return memberError;
        }

        if (_expirationService.IsExpired(manifest.Album.ExpiresAt))
        {
            await _expirationService.EnforceAlbumExpirationAsync(manifest.AlbumId);
            return StatusCode(StatusCodes.Status410Gone);
        }

        var ifMatchError = ValidateIfMatchOrWarn(manifest, "expiration");
        if (ifMatchError != null)
        {
            return ifMatchError;
        }

        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= _timeProvider.GetUtcNow())
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        manifest.ExpiresAt = request.ExpiresAt;
        manifest.UpdatedAt = _timeProvider.GetUtcNow().UtcDateTime;
        manifest.MetadataVersion++;
        manifest.Album.CurrentVersion++;
        manifest.Album.UpdatedAt = manifest.UpdatedAt;
        manifest.VersionCreated = manifest.Album.CurrentVersion;

        await _db.SaveChangesAsync();
        SetManifestETag(manifest);

        return Ok(new ManifestExpirationUpdateResponse(
            manifest.Id,
            manifest.ExpiresAt,
            manifest.VersionCreated));
    }

    /// <summary>
    /// Get a specific manifest
    /// </summary>
    [HttpGet("{manifestId}")]
    public async Task<IActionResult> Get(Guid manifestId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var manifest = await _db.Manifests
            .AsNoTracking()
            .Include(m => m.Album)
            .Include(m => m.ManifestShards.OrderBy(ms => ms.ChunkIndex))
            .FirstOrDefaultAsync(m => m.Id == manifestId);

        if (manifest == null)
        {
            return NotFound();
        }

        // Verify access
        var accessError = await _db.RequireAlbumMemberAsync(manifest.AlbumId, user.Id);
        if (accessError != null)
        {
            return accessError;
        }

        if (_expirationService.IsExpired(manifest.Album.ExpiresAt))
        {
            await _expirationService.EnforceAlbumExpirationAsync(manifest.AlbumId);
            return StatusCode(StatusCodes.Status410Gone);
        }

        SetManifestETag(manifest);
        return Ok(new
        {
            ProtocolVersion = manifest.ProtocolVersion,
            // audit-projections-getmanifest: frontend ManifestRecordSchema
            // requires top-level `id` (UUID). Earlier projections shipped
            // `manifestId` which Zod rejected as a missing required field,
            // surfacing as a synthetic 500 in the client and cascading into
            // any flow that fetched a single manifest by ID.
            Id = manifest.Id,
            manifest.AlbumId,
            manifest.AssetType,
            manifest.MetadataVersion,
            manifest.CreatedAt,
            manifest.VersionCreated,
            manifest.IsDeleted,
            manifest.EncryptedMeta,
            manifest.EncryptedMetaSidecar,
            manifest.Signature,
            manifest.SignerPubkey,
            manifest.ExpiresAt,
            // Legacy format for backward compatibility
            ShardIds = manifest.ManifestShards
                .OrderBy(ms => ms.ChunkIndex)
                .Select(ms => ms.ShardId),
            // audit-projections-getmanifest: ManifestShardProjectionSchema
            // requires shardIndex, sha256 (lowercase hex), contentLength,
            // and envelopeVersion in addition to shardId/tier. Mirror the
            // /albums/{id}/sync projection (AlbumsController.cs:525-535).
            Shards = manifest.ManifestShards
                .OrderBy(ms => ms.ChunkIndex)
                .Select(ms => new
                {
                    ms.ShardId,
                    ms.Tier,
                    ms.ShardIndex,
                    Sha256 = ms.Sha256.ToLower(),
                    ms.ContentLength,
                    ms.EnvelopeVersion
                }),
            // TieredShards preserved for any consumer relying on the
            // tier-first ordering; the canonical projection is now Shards.
            TieredShards = manifest.ManifestShards
                .OrderBy(ms => ms.Tier)
                .ThenBy(ms => ms.ShardIndex)
                .Select(ms => new
                {
                    ms.Tier,
                    ms.ShardIndex,
                    ms.ShardId,
                    ms.Sha256,
                    ms.ContentLength,
                    ms.EnvelopeVersion
                }),
            manifest.UpdatedAt
        });
    }

    /// <summary>
    /// Soft-delete a manifest. Optionally accepts a signed tombstone
    /// transcript (batch 5b — A2). When the client supplies a signature,
    /// the server stores it on the row; sync responses surface it so other
    /// clients can verify before purging local state (closes audit
    /// <c>sync C2 (unauthenticated tombstones)</c>). Pre-A2 clients omit
    /// the body — the field stays NULL and the legacy unsigned-delete
    /// behavior is preserved during migration.
    /// </summary>
    [NonAction]
    public Task<IActionResult> Delete(Guid manifestId, [FromBody] DeleteManifestRequest? request = null)
        => DeleteCoreAsync(manifestId, request, requireSequenceReservation: false);

    [HttpDelete("{manifestId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public Task<IActionResult> DeleteV2(Guid manifestId, [FromBody] DeleteManifestRequest request)
        => DeleteCoreAsync(manifestId, request, requireSequenceReservation: true);

    private async Task<IActionResult> DeleteCoreAsync(
        Guid manifestId,
        DeleteManifestRequest? request,
        bool requireSequenceReservation)
    {
        if (requireSequenceReservation
            && (request == null
                || string.IsNullOrWhiteSpace(request.TombstoneSignature)
                || !request.SignerEpochId.HasValue
                || !request.TombstoneSeq.HasValue
                || request.TombstoneSeq.Value <= 0
                || !request.SequenceReservationId.HasValue
                || !request.TombstoneVersionCreated.HasValue))
        {
            return Problem(
                detail: "A v2 signed tombstone, signer epoch, positive sequence, signed target version, and sequence reservation are required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // Resolve the immutable parent without tracking the manifest,
            // then serialize with every other signed mutation on the album.
            var albumId = await _db.Manifests
                .IgnoreQueryFilters()
                .AsNoTracking()
                .Where(candidate => candidate.Id == manifestId && !candidate.IsDeleted)
                .Select(candidate => (Guid?)candidate.AlbumId)
                .FirstOrDefaultAsync();
            if (!albumId.HasValue)
            {
                return NotFound();
            }

            Album? album;
            if (_db.UsesLiteProvider())
            {
                album = await _db.Albums.FindAsync(albumId.Value);
            }
            else
            {
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", albumId.Value)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return NotFound();
            }

            // Load after the lock so the signed target version, ETag state,
            // and deletion decision cannot come from a pre-wait snapshot.
            var manifest = await _db.Manifests
                .IgnoreQueryFilters()
                .FirstOrDefaultAsync(candidate => candidate.Id == manifestId);
            if (manifest == null || manifest.IsDeleted)
            {
                return NotFound();
            }

            // Verify editor/owner access
            var (_, memberError) = await _db.RequireAlbumEditorAsync(album.Id, user.Id);
            if (memberError != null)
            {
                return memberError;
            }

            if (_expirationService.IsExpired(album.ExpiresAt))
            {
                await _expirationService.EnforceAlbumExpirationAsync(album.Id);
                return StatusCode(StatusCodes.Status410Gone);
            }

            if (requireSequenceReservation)
            {
                var v2Request = request!;
                if (!TryDecodeBase64(v2Request.TombstoneSignature, out var signatureBytes)
                    || signatureBytes.Length != 64)
                {
                    return Problem(
                        detail: "tombstoneSignature must be a base64-encoded 64-byte Ed25519 signature",
                        statusCode: StatusCodes.Status400BadRequest);
                }

                if (v2Request.SignerEpochId != album.CurrentEpochId)
                {
                    return Problem(
                        detail: "tombstones require the current album epoch signer",
                        statusCode: StatusCodes.Status409Conflict);
                }

                if (v2Request.TombstoneVersionCreated != manifest.VersionCreated)
                {
                    return Problem(
                        detail: "tombstoneVersionCreated does not match the current target manifest version",
                        statusCode: StatusCodes.Status409Conflict);
                }

                var reservedSignerPubkey = await _db.ManifestSequenceReservations
                    .Where(candidate => candidate.Id == v2Request.SequenceReservationId)
                    .Select(candidate => candidate.SignerPubkey)
                    .FirstOrDefaultAsync();
                if (!TryDecodeBase64(reservedSignerPubkey, out var signerPubkeyBytes)
                    || signerPubkeyBytes.Length != 32
                    || !await _db.EpochKeys.AnyAsync(key =>
                        key.AlbumId == album.Id
                        && key.EpochId == album.CurrentEpochId
                        && key.SignPubkey == signerPubkeyBytes))
                {
                    return Problem(
                        detail: "Sequence reservation signer is not the current epoch signing key",
                        statusCode: StatusCodes.Status409Conflict);
                }

                var sequenceError = await ConsumeSequenceReservationAsync(
                    album.Id,
                    reservedSignerPubkey!,
                    manifest.Id,
                    ManifestSequenceOperations.Tombstone,
                    v2Request.SequenceReservationId,
                    v2Request.TombstoneSeq);
                if (sequenceError != null)
                {
                    return sequenceError;
                }

                manifest.TombstoneSignature = signatureBytes;
                manifest.TombstoneSignerEpochId = v2Request.SignerEpochId;
                manifest.TombstoneProtocolVersion = 2;
                manifest.TombstoneSeq = v2Request.TombstoneSeq;
                manifest.TombstoneVersionCreated = v2Request.TombstoneVersionCreated;
            }
            else if (request is not null
                && !string.IsNullOrEmpty(request.TombstoneSignature)
                && request.SignerEpochId is int legacySignerEpochId)
            {
                if (!TryDecodeBase64(request.TombstoneSignature, out var signatureBytes)
                    || signatureBytes.Length != 64)
                {
                    return Problem(
                        detail: "tombstoneSignature must be a base64-encoded 64-byte Ed25519 signature",
                        statusCode: StatusCodes.Status400BadRequest);
                }
                manifest.TombstoneSignature = signatureBytes;
                manifest.TombstoneSignerEpochId = legacySignerEpochId;
            }
            else if (request is not null
                && (!string.IsNullOrEmpty(request.TombstoneSignature) ^ request.SignerEpochId.HasValue))
            {
                return Problem(
                    detail: "tombstoneSignature and signerEpochId must be supplied together or both omitted",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            // Advance the row to a deletion cursor while preserving the
            // pre-delete version separately for v2 transcript verification.
            var deletedAt = _timeProvider.GetUtcNow().UtcDateTime;
            manifest.IsDeleted = true;
            manifest.UpdatedAt = deletedAt;
            album.CurrentVersion++;
            manifest.VersionCreated = album.CurrentVersion;
            album.UpdatedAt = deletedAt;

            var cleanupResult = await ShardReferenceCleanup.DetachManifestShardsAsync(
                _db,
                [manifestId],
                deletedAt);

            // Update album limits - decrement photo count and size
            var albumLimits = await _db.AlbumLimits.FindAsync(album.Id);
            if (albumLimits != null)
            {
                albumLimits.CurrentPhotoCount = Math.Max(0, albumLimits.CurrentPhotoCount - 1);
                albumLimits.CurrentSizeBytes = Math.Max(0, albumLimits.CurrentSizeBytes - cleanupResult.TotalDetachedSizeBytes);
                albumLimits.UpdatedAt = deletedAt;
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return NoContent();
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    private async Task<ManifestSequenceState> GetOrCreateSequenceStateAsync(
        Guid albumId,
        string canonicalSignerPubkey)
    {
        var state = await _db.ManifestSequenceStates.FindAsync(albumId, canonicalSignerPubkey);
        if (state != null)
        {
            return state;
        }

        var priorManifestSequence = await _db.Manifests
            .IgnoreQueryFilters()
            .Where(manifest => manifest.AlbumId == albumId
                && manifest.SignerPubkey == canonicalSignerPubkey
                && manifest.ManifestSeq.HasValue)
            .MaxAsync(manifest => (long?)manifest.ManifestSeq) ?? 0L;
        var priorConsumedReservation = await _db.ManifestSequenceReservations
            .Where(reservation => reservation.AlbumId == albumId
                && reservation.SignerPubkey == canonicalSignerPubkey
                && reservation.ConsumedAt.HasValue)
            .MaxAsync(reservation => (long?)reservation.ManifestSeq) ?? 0L;
        var priorAllocatedReservation = await _db.ManifestSequenceReservations
            .Where(reservation => reservation.AlbumId == albumId
                && reservation.SignerPubkey == canonicalSignerPubkey)
            .MaxAsync(reservation => (long?)reservation.ManifestSeq) ?? 0L;
        var priorConsumedSequence = Math.Max(priorManifestSequence, priorConsumedReservation);

        state = new ManifestSequenceState
        {
            AlbumId = albumId,
            SignerPubkey = canonicalSignerPubkey,
            LastAllocatedSequence = Math.Max(priorConsumedSequence, priorAllocatedReservation),
            LastConsumedSequence = priorConsumedSequence
        };
        _db.ManifestSequenceStates.Add(state);
        return state;
    }

    private async Task<IActionResult?> ConsumeSequenceReservationAsync(
        Guid albumId,
        string canonicalSignerPubkey,
        Guid targetManifestId,
        string operationKind,
        Guid? reservationId,
        long? manifestSeq)
    {
        if (!reservationId.HasValue || !manifestSeq.HasValue || manifestSeq.Value <= 0)
        {
            return Problem(
                detail: "A positive signed sequence and sequenceReservationId are required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var reservation = await _db.ManifestSequenceReservations
            .FirstOrDefaultAsync(candidate => candidate.Id == reservationId.Value);
        if (reservation == null)
        {
            return Problem(
                detail: "Sequence reservation was not found",
                statusCode: StatusCodes.Status409Conflict);
        }

        if (reservation.AlbumId != albumId
            || reservation.SignerPubkey != canonicalSignerPubkey
            || reservation.TargetManifestId != targetManifestId
            || reservation.OperationKind != operationKind
            || reservation.ManifestSeq != manifestSeq.Value)
        {
            return Problem(
                detail: "Sequence reservation does not match this signed mutation",
                statusCode: StatusCodes.Status409Conflict);
        }

        if (reservation.ConsumedAt.HasValue)
        {
            return Problem(
                detail: "Sequence reservation has already been consumed",
                statusCode: StatusCodes.Status409Conflict);
        }

        var state = await _db.ManifestSequenceStates.FindAsync(albumId, canonicalSignerPubkey);
        if (state == null)
        {
            return Problem(
                detail: "Sequence allocator state was not found; reserve a new sequence and re-sign the mutation",
                statusCode: StatusCodes.Status409Conflict);
        }

        if (manifestSeq.Value <= state.LastConsumedSequence)
        {
            var problem = new ProblemDetails
            {
                Status = StatusCodes.Status409Conflict,
                Title = "Conflict",
                Detail = "Manifest sequence is stale because a newer reservation already committed; retry the sequence reservation and re-sign the mutation"
            };
            problem.Extensions["code"] = "MANIFEST_SEQUENCE_STALE";
            return new ObjectResult(problem)
            {
                StatusCode = StatusCodes.Status409Conflict
            };
        }

        state.LastConsumedSequence = manifestSeq.Value;
        reservation.ConsumedAt = _timeProvider.GetUtcNow().UtcDateTime;
        return null;
    }

    private static bool TryDecodeBase64(string? value, out byte[] bytes)
    {
        bytes = [];

        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        try
        {
            bytes = Convert.FromBase64String(value);
            return bytes.Length > 0;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private void SetManifestETag(Manifest manifest)
        => SetManifestETag(manifest.MetadataVersion);

    private void SetManifestETag(long metadataVersion)
        => Response.Headers["ETag"] = $"\"{metadataVersion}\"";

    private IActionResult? ValidateIfMatchOrWarn(Manifest manifest, string endpointName)
    {
        var ifMatchValues = Request.Headers.IfMatch;
        if (ifMatchValues.Count == 0)
        {
            _logger.LogWarning(
                "Manifest {ManifestId} {EndpointName} update accepted without If-Match header",
                manifest.Id,
                endpointName);
            Response.Headers["Deprecation"] = "true";
            return null;
        }

        if (ifMatchValues.Any(value => MatchesMetadataVersionETag(value, manifest.MetadataVersion)))
        {
            return null;
        }

        SetManifestETag(manifest);
        return StatusCode(StatusCodes.Status412PreconditionFailed, new
        {
            error = "Precondition failed",
            detail = "If-Match does not match the current manifest metadata version.",
            currentMetadataVersion = manifest.MetadataVersion
        });
    }

    private static bool MatchesMetadataVersionETag(string? headerValue, long metadataVersion)
    {
        if (string.IsNullOrWhiteSpace(headerValue))
        {
            return false;
        }

        if (headerValue.Trim() == "*")
        {
            return true;
        }

        var expected = metadataVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return headerValue
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(candidate =>
                string.Equals(candidate.Trim('"'), expected, StringComparison.Ordinal));
    }
}
