using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Logging;
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

    public ManifestsController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService,
        ICurrentUserService currentUserService,
        ILogger<ManifestsController> logger,
        IAlbumExpirationService? expirationService = null,
        TimeProvider? timeProvider = null)
    {
        _db = db;
        _quotaService = quotaService;
        _currentUserService = currentUserService;
        _logger = logger;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _expirationService = expirationService ?? new AlbumExpirationService(
            db,
            _timeProvider,
            NullLogger<AlbumExpirationService>.Instance);

    }



    /// <summary>
    /// Create a new finalized manifest (photo) in an album.
    /// </summary>
    [HttpPost]
    public Task<IActionResult> Create([FromBody] CreateManifestRequest request)
        => FinalizeManifestCoreAsync(Guid.CreateVersion7(), request);

    /// <summary>
    /// Finalize a client-addressed manifest id using the ADR-022 v1 shape.
    /// </summary>
    [HttpPost("{manifestId:guid}/finalize")]
    [ProducesResponseType(StatusCodes.Status201Created)]
    public Task<IActionResult> Finalize(Guid manifestId, [FromBody] CreateManifestRequest request)
        => FinalizeManifestCoreAsync(manifestId, request);

    private async Task<IActionResult> FinalizeManifestCoreAsync(Guid manifestId, CreateManifestRequest request)
    {
        var validationError = ValidateFinalizeRequest(request);
        if (validationError != null)
        {
            return validationError;
        }

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

            if (await _db.Manifests.IgnoreQueryFilters().AnyAsync(m => m.Id == manifestId))
            {
                return Conflict(new
                {
                    error = "Manifest already finalized",
                    detail = "The supplied manifest id has already been finalized.",
                    manifestId
                });
            }

            // A5: reject manifests signed by an epoch older than the album's
            // current epoch. Without this check, a stale client (e.g. a tab
            // that was kept open across an admin's member-removal + epoch
            // rotation) can keep uploading new content encrypted under the
            // OLD epoch — readable by the just-removed member who retained
            // their copy of the old epoch keys. Identifying the manifest's
            // epoch from the SignerPubkey is the only ZK-safe option (the
            // server cannot parse the encrypted manifest envelope itself).
            if (TryDecodeBase64(request.SignerPubkey, out var signerPubkeyBytesForEpochLookup)
                && signerPubkeyBytesForEpochLookup.Length == 32)
            {
                var manifestEpochId = await _db.EpochKeys
                    .Where(ek => ek.AlbumId == album.Id && ek.SignPubkey == signerPubkeyBytesForEpochLookup)
                    .Select(ek => (int?)ek.EpochId)
                    .FirstOrDefaultAsync();
                if (manifestEpochId == null)
                {
                    return Problem(
                        detail: "Manifest signed by an unknown epoch key for this album",
                        statusCode: StatusCodes.Status400BadRequest);
                }
                if (manifestEpochId.Value < album.CurrentEpochId)
                {
                    return Problem(
                        detail: $"Manifest signed by stale epoch ({manifestEpochId.Value}); album is at epoch {album.CurrentEpochId}. Re-encrypt with the current epoch and retry.",
                        statusCode: StatusCodes.Status409Conflict);
                }

                // 6d-guard (A3, audit crypto-correctness H-1): when the
                // client supplied a v2 transcript with a manifest_seq
                // freshness field, enforce strict monotonicity per
                // (album_id, signer_pubkey). SignerPubkey uniquely
                // identifies the epoch (it's the per-epoch
                // ManifestSigningPubkey), so this is functionally
                // (album_id, epoch_id) scoping. A malicious or compromised
                // server cannot replay an older signed manifest under a
                // newer seq because Ed25519 binds the bytes — the only
                // freshness lever is the seq stored in the transcript and
                // the server's max-seq check. Pre-A3 clients omit
                // ManifestSeq and skip this guard (NULL stays NULL on
                // disk).
                if (request.ManifestSeq.HasValue)
                {
                    var maxSeqForEpoch = await _db.Manifests
                        .IgnoreQueryFilters()
                        .Where(m => m.AlbumId == album.Id
                            && m.SignerPubkey == request.SignerPubkey
                            && m.ManifestSeq != null)
                        .MaxAsync(m => (long?)m.ManifestSeq) ?? 0L;
                    if (request.ManifestSeq.Value <= maxSeqForEpoch)
                    {
                        return Problem(
                            detail: $"Manifest seq {request.ManifestSeq.Value} is not strictly greater than the current max {maxSeqForEpoch} for this album+epoch. Increment seq and retry.",
                            statusCode: StatusCodes.Status409Conflict);
                    }
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
                SignerPubkey = request.SignerPubkey,
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

            if (tieredShard.EnvelopeVersion != 3)
            {
                return Problem(
                    detail: "tieredShards envelopeVersion must be 3",
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
        IReadOnlyCollection<(Guid Id, int Tier, int ShardIndex, string? Sha256, long? ContentLength, int EnvelopeVersion)> shardInfoList)
        => new()
        {
            ProtocolVersion = manifest.ProtocolVersion,
            ManifestId = manifest.Id,
            MetadataVersion = manifest.MetadataVersion,
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
    [HttpPatch("{manifestId:guid}/metadata")]
    [ProducesResponseType<ManifestMetadataUpdateResponse>(StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateMetadata(Guid manifestId, [FromBody] UpdateManifestMetadataRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var manifest = await _db.Manifests
                .IgnoreQueryFilters()
                .Include(m => m.Album)
                .FirstOrDefaultAsync(m => m.Id == manifestId);

            if (manifest == null || manifest.IsDeleted)
            {
                return NotFound();
            }

            // Lock album row (FOR UPDATE is PostgreSQL-only; SQLite uses simpler locking)
            Album? album;
            if (_db.UsesLiteProvider())
            {
                album = await _db.Albums.FindAsync(manifest.AlbumId);
            }
            else
            {
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", manifest.AlbumId)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return NotFound();
            }

            var (_, memberError) = await _db.RequireAlbumEditorAsync(album.Id, user.Id, new NotFoundResult());
            if (memberError != null)
            {
                return memberError;
            }

            if (_expirationService.IsExpired(album.ExpiresAt) || _expirationService.IsExpired(manifest.ExpiresAt))
            {
                await _expirationService.EnforceManifestExpirationAsync(manifestId);
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

            manifest.EncryptedMeta = encryptedMeta;
            manifest.Signature = request.Signature;
            manifest.SignerPubkey = request.SignerPubkey;
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
    /// Update photo expiration settings. Album owners and editors can update photo lifecycle metadata.
    /// </summary>
    [HttpPatch("{manifestId:guid}/expiration")]
    [ProducesResponseType<ManifestExpirationUpdateResponse>(StatusCodes.Status200OK)]
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

        if (_expirationService.IsExpired(manifest.Album.ExpiresAt) || _expirationService.IsExpired(manifest.ExpiresAt))
        {
            await _expirationService.EnforceManifestExpirationAsync(manifestId);
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

        if (_expirationService.IsExpired(manifest.Album.ExpiresAt) || _expirationService.IsExpired(manifest.ExpiresAt))
        {
            await _expirationService.EnforceManifestExpirationAsync(manifestId);
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
    [HttpDelete("{manifestId}")]
    public async Task<IActionResult> Delete(Guid manifestId, [FromBody] DeleteManifestRequest? request = null)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var manifest = await _db.Manifests.FindAsync(manifestId);
            if (manifest == null)
            {
                return NotFound();
            }

            // Lock album (FOR UPDATE is PostgreSQL-only; SQLite uses simpler locking)
            Album? album;
            if (_db.UsesLiteProvider())
            {
                album = await _db.Albums.FindAsync(manifest.AlbumId);
            }
            else
            {
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", manifest.AlbumId)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return NotFound();
            }

            // Verify editor/owner access
            var (_, memberError) = await _db.RequireAlbumEditorAsync(album.Id, user.Id);
            if (memberError != null)
            {
                return memberError;
            }

            if (_expirationService.IsExpired(album.ExpiresAt) || _expirationService.IsExpired(manifest.ExpiresAt))
            {
                await _expirationService.EnforceManifestExpirationAsync(manifestId);
                return StatusCode(StatusCodes.Status410Gone);
            }

            // A2: persist the signed tombstone transcript when supplied.
            // Both fields must be present together. We do NOT verify the
            // signature server-side — the canonical check is the client's
            // pre-purge verification (zero-knowledge invariant: the server
            // is never the authority on signature validity). Other client
            // sessions verify the signature using the album's published
            // epoch signing pubkey before acting on the tombstone.
            if (request is not null
                && !string.IsNullOrEmpty(request.TombstoneSignature)
                && request.SignerEpochId is int signerEpochId)
            {
                if (!TryDecodeBase64(request.TombstoneSignature, out var signatureBytes)
                    || signatureBytes.Length == 0)
                {
                    return Problem(
                        detail: "tombstoneSignature must be valid base64 and non-empty",
                        statusCode: StatusCodes.Status400BadRequest);
                }
                if (signatureBytes.Length != 64)
                {
                    return Problem(
                        detail: "tombstoneSignature must be a 64-byte Ed25519 signature",
                        statusCode: StatusCodes.Status400BadRequest);
                }
                manifest.TombstoneSignature = signatureBytes;
                manifest.TombstoneSignerEpochId = signerEpochId;
            }
            else if (request is not null
                && (!string.IsNullOrEmpty(request.TombstoneSignature) ^ request.SignerEpochId.HasValue))
            {
                return Problem(
                    detail: "tombstoneSignature and signerEpochId must be supplied together or both omitted",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            // Soft delete
            manifest.IsDeleted = true;
            manifest.UpdatedAt = DateTime.UtcNow;
            album.CurrentVersion++;
            album.UpdatedAt = DateTime.UtcNow;

            var cleanupResult = await ShardReferenceCleanup.DetachManifestShardsAsync(
                _db,
                [manifestId],
                DateTime.UtcNow);

            // Update album limits - decrement photo count and size
            var albumLimits = await _db.AlbumLimits.FindAsync(album.Id);
            if (albumLimits != null)
            {
                albumLimits.CurrentPhotoCount = Math.Max(0, albumLimits.CurrentPhotoCount - 1);
                albumLimits.CurrentSizeBytes = Math.Max(0, albumLimits.CurrentSizeBytes - cleanupResult.TotalDetachedSizeBytes);
                albumLimits.UpdatedAt = DateTime.UtcNow;
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
        => Response.Headers["ETag"] = $"\"{manifest.MetadataVersion}\"";

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
