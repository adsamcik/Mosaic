using System.IO.Compression;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// GDPR Article 20 (right to data portability) endpoint (v1.0.x s38).
///
/// <para>
/// Streams a zip archive of the caller's entire data footprint: per-album
/// manifests, encrypted metadata sidecars, member rosters, share-link
/// records, and per-shard encrypted blobs, plus the user's wrapped account
/// key (L2 wrapped by L1) and KDF salt material so the export can be
/// decrypted offline by the user (who alone holds the password-derived L0
/// / L1 keys).
/// </para>
///
/// <para>
/// Zero-knowledge invariants preserved:
/// <list type="bullet">
///   <item>The server only ever copies opaque ciphertext bytes — it does
///         not parse, decrypt, or inspect any user content.</item>
///   <item>The wrapped account key included in the export is the same
///         <c>WrappedAccountKey</c> already returned by
///         <c>GET /api/v1/users/me</c>; exporting it does not weaken any
///         existing posture.</item>
///   <item>Salt material is needed for offline KDF replay and is already
///         considered non-secret per the threat model (it is plaintext on
///         disk and returned by <c>GET /me</c>).</item>
/// </list>
/// </para>
///
/// <para>
/// Streaming: the archive is written directly to <c>Response.Body</c> with
/// <see cref="ZipArchive"/> in <see cref="ZipArchiveMode.Create"/> mode and
/// per-shard <see cref="Stream.CopyToAsync(Stream, CancellationToken)"/>
/// — at no point is the full archive (nor any single shard) materialised
/// in a managed buffer. Output buffering is suppressed via
/// <see cref="IHttpResponseBodyFeature.DisableBuffering"/> so the first
/// bytes hit the wire as soon as the central directory header is written.
/// </para>
/// </summary>
[ApiController]
[Route("api/v1/export")]
public class ExportController : ControllerBase
{
    private const string ExportFormatVersion = "1.0";

    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;
    private readonly ICurrentUserService _currentUserService;
    private readonly IAuditLogService? _auditLog;
    private readonly ILogger<ExportController> _logger;

    public ExportController(
        MosaicDbContext db,
        IStorageService storage,
        ICurrentUserService currentUserService,
        ILogger<ExportController>? logger = null,
        IAuditLogService? auditLog = null)
    {
        _db = db;
        _storage = storage;
        _currentUserService = currentUserService;
        _auditLog = auditLog;
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<ExportController>.Instance;
    }

    /// <summary>
    /// Streams the caller's entire data footprint as a zip archive.
    /// </summary>
    /// <remarks>
    /// Layout (see <c>docs/EXPORT_FORMAT.md</c> for the authoritative spec):
    /// <code>
    /// metadata.json
    /// account-key-wrapped.bin
    /// salt.bin
    /// salt-version.json
    /// albums/&lt;album-id&gt;/album.json
    /// albums/&lt;album-id&gt;/members.json
    /// albums/&lt;album-id&gt;/share-links.json
    /// albums/&lt;album-id&gt;/epoch-keys.json
    /// albums/&lt;album-id&gt;/manifests/&lt;manifest-id&gt;.json
    /// albums/&lt;album-id&gt;/manifests/&lt;manifest-id&gt;.encrypted-meta.bin
    /// albums/&lt;album-id&gt;/manifests/&lt;manifest-id&gt;.encrypted-meta-sidecar.bin
    /// albums/&lt;album-id&gt;/shards/&lt;shard-id&gt;.bin
    /// </code>
    /// </remarks>
    [HttpGet]
    public async Task Export(CancellationToken ct)
    {
        User user;
        try
        {
            user = await _currentUserService.GetOrCreateAsync(HttpContext);
        }
        catch (UnauthorizedAccessException)
        {
            Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        var userId = user.Id;
        var exportedAt = DateTime.UtcNow;
        var filename = $"mosaic-export-{userId}-{exportedAt:yyyyMMdd-HHmmss}.zip";

        // Disable response buffering so the first bytes flow to the client
        // as soon as ZipArchive writes its first local file header.
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        Response.ContentType = "application/zip";
        Response.Headers["Content-Disposition"] = $"attachment; filename=\"{filename}\"";
        // Mirror the cache-control posture of GET /me — never cache an
        // export response, it is personal and time-sensitive.
        Response.Headers["Cache-Control"] = "no-store";

        // Load the per-album metadata upfront (small JSON-shaped rows). The
        // big blob bytes are streamed lazily one shard at a time below.
        var ownedAlbums = await _db.Albums
            .AsNoTracking()
            .Where(a => a.OwnerId == userId)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);

        long totalShardBytes = 0;
        int totalShards = 0;
        int totalManifests = 0;
        int totalShareLinks = 0;

        // leaveOpen: true → we do not let ZipArchive close Response.Body.
        // Kestrel owns the body stream and will close it after the action
        // returns; closing it here would short-circuit the pipeline.
        using (var zip = new ZipArchive(Response.Body, ZipArchiveMode.Create, leaveOpen: true))
        {
            await WriteJsonEntryAsync(zip, "metadata.json", new
            {
                userId,
                exportedAt,
                version = ExportFormatVersion,
                note = "Mosaic GDPR Article 20 export. All blobs are ciphertext; decrypt offline with your password. See docs/EXPORT_FORMAT.md."
            }, ct);

            // Wrapped account key (L2 wrapped by L1). Already considered
            // non-secret at rest — the server stores it and returns it from
            // GET /me. Including it lets the user decrypt offline.
            if (user.WrappedAccountKey is { Length: > 0 } wrappedAccountKey)
            {
                await WriteBytesEntryAsync(zip, "account-key-wrapped.bin", wrappedAccountKey, ct);
            }
            if (user.WrappedIdentitySeed is { Length: > 0 } wrappedIdentitySeed)
            {
                await WriteBytesEntryAsync(zip, "identity-seed-wrapped.bin", wrappedIdentitySeed, ct);
            }

            // Salt material for offline KDF replay.
            if (user.UserSalt is { Length: > 0 } userSalt)
            {
                await WriteBytesEntryAsync(zip, "salt.bin", userSalt, ct);
            }
            if (user.AccountSalt is { Length: > 0 } accountSalt)
            {
                await WriteBytesEntryAsync(zip, "account-salt.bin", accountSalt, ct);
            }

            await WriteJsonEntryAsync(zip, "kdf-params.json", new
            {
                user.SaltVersion,
                user.KdfAlgVersion,
                user.KdfMemoryKib,
                user.KdfIterations,
                user.KdfParallelism
            }, ct);

            foreach (var album in ownedAlbums)
            {
                ct.ThrowIfCancellationRequested();
                var prefix = $"albums/{album.Id}/";

                await WriteJsonEntryAsync(zip, prefix + "album.json", new
                {
                    album.Id,
                    album.OwnerId,
                    album.CurrentEpochId,
                    album.CurrentVersion,
                    album.CreatedAt,
                    album.UpdatedAt,
                    album.EncryptedName,
                    album.EncryptedDescription,
                    album.ExpiresAt,
                    album.ExpirationWarningDays,
                    MemberRosterSignature = album.MemberRosterSignature,
                    album.MemberRosterSignerEpochId,
                    album.MemberRosterVersion
                }, ct);

                var members = await _db.AlbumMembers
                    .AsNoTracking()
                    .Where(m => m.AlbumId == album.Id)
                    .Select(m => new
                    {
                        m.AlbumId,
                        m.UserId,
                        m.Role,
                        m.InvitedBy,
                        m.JoinedAt,
                        m.RevokedAt
                    })
                    .ToListAsync(ct);
                await WriteJsonEntryAsync(zip, prefix + "members.json", members, ct);

                var shareLinks = await _db.ShareLinks
                    .AsNoTracking()
                    .Where(sl => sl.AlbumId == album.Id)
                    .Select(sl => new
                    {
                        sl.Id,
                        LinkId = sl.LinkId,
                        sl.AlbumId,
                        sl.AccessTier,
                        OwnerEncryptedSecret = sl.OwnerEncryptedSecret,
                        sl.ExpiresAt,
                        sl.MaxUses,
                        sl.UseCount,
                        sl.IsRevoked,
                        sl.CreatedAt
                    })
                    .ToListAsync(ct);
                await WriteJsonEntryAsync(zip, prefix + "share-links.json", shareLinks, ct);
                totalShareLinks += shareLinks.Count;

                var epochKeys = await _db.EpochKeys
                    .AsNoTracking()
                    .Where(e => e.AlbumId == album.Id)
                    .Select(e => new
                    {
                        e.Id,
                        e.AlbumId,
                        e.RecipientId,
                        e.EpochId,
                        e.EncryptedKeyBundle,
                        e.OwnerSignature,
                        e.SharerPubkey,
                        e.SignPubkey,
                        e.CreatedAt
                    })
                    .ToListAsync(ct);
                await WriteJsonEntryAsync(zip, prefix + "epoch-keys.json", epochKeys, ct);

                var manifests = await _db.Manifests
                    .AsNoTracking()
                    .IgnoreQueryFilters()
                    .Where(m => m.AlbumId == album.Id)
                    .Include(m => m.ManifestShards)
                    .OrderBy(m => m.CreatedAt)
                    .ToListAsync(ct);

                foreach (var manifest in manifests)
                {
                    ct.ThrowIfCancellationRequested();
                    var manifestPrefix = prefix + "manifests/" + manifest.Id;

                    await WriteJsonEntryAsync(zip, manifestPrefix + ".json", new
                    {
                        manifest.Id,
                        manifest.AlbumId,
                        manifest.ProtocolVersion,
                        manifest.AssetType,
                        manifest.VersionCreated,
                        manifest.MetadataVersion,
                        manifest.IsDeleted,
                        manifest.Signature,
                        manifest.SignerPubkey,
                        manifest.CreatedAt,
                        manifest.UpdatedAt,
                        TombstoneSignature = manifest.TombstoneSignature,
                        manifest.TombstoneSignerEpochId,
                        manifest.ManifestSeq,
                        manifest.ExpiresAt,
                        ManifestShards = manifest.ManifestShards
                            .OrderBy(ms => ms.ChunkIndex)
                            .ThenBy(ms => ms.ShardIndex)
                            .Select(ms => new
                            {
                                ms.ShardId,
                                ms.ChunkIndex,
                                ms.ShardIndex,
                                ms.Tier,
                                ms.Sha256,
                                ms.ContentLength,
                                ms.EnvelopeVersion
                            })
                    }, ct);

                    if (manifest.EncryptedMeta is { Length: > 0 })
                    {
                        await WriteBytesEntryAsync(zip, manifestPrefix + ".encrypted-meta.bin", manifest.EncryptedMeta, ct);
                    }
                    if (manifest.EncryptedMetaSidecar is { Length: > 0 })
                    {
                        await WriteBytesEntryAsync(zip, manifestPrefix + ".encrypted-meta-sidecar.bin", manifest.EncryptedMetaSidecar, ct);
                    }
                    totalManifests++;
                }

                // Collect the unique set of shards referenced by this
                // album's manifests and stream each blob exactly once.
                var shardIds = manifests
                    .SelectMany(m => m.ManifestShards.Select(ms => ms.ShardId))
                    .Distinct()
                    .ToList();
                if (shardIds.Count > 0)
                {
                    var shards = await _db.Shards
                        .AsNoTracking()
                        .Where(s => shardIds.Contains(s.Id))
                        .ToListAsync(ct);

                    foreach (var shard in shards)
                    {
                        ct.ThrowIfCancellationRequested();
                        var entryName = $"{prefix}shards/{shard.Id}.bin";
                        var streamed = await TryStreamShardAsync(zip, entryName, shard, ct);
                        if (streamed)
                        {
                            totalShardBytes += shard.SizeBytes;
                            totalShards++;
                        }
                    }
                }
            }
        }

        // Audit AFTER the archive is fully written so the row records what
        // the user actually walked away with. Best-effort: AuditLogService
        // already swallows persistence failures.
        if (_auditLog is not null)
        {
            await _auditLog.WriteAsync(
                AuditEventTypes.UserDataExported,
                AuditOutcomes.Success,
                HttpContext,
                actorUserId: userId,
                targetType: "user",
                targetId: userId.ToString(),
                details: new
                {
                    albums = ownedAlbums.Count,
                    manifests = totalManifests,
                    shards = totalShards,
                    shardBytes = totalShardBytes,
                    shareLinks = totalShareLinks,
                    formatVersion = ExportFormatVersion
                },
                ct: CancellationToken.None);
        }
    }

    private async Task<bool> TryStreamShardAsync(ZipArchive zip, string entryName, Shard shard, CancellationToken ct)
    {
        Stream? source = null;
        try
        {
            source = await _storage.OpenReadAsync(shard.StorageKey);
        }
        catch (ShardMissingException)
        {
            // A shard row whose blob has already been GCed is exported as
            // an empty .missing marker so the user can audit what was lost.
            // We deliberately do NOT abort the whole export — a single
            // corrupted/missing blob would otherwise deny the user their
            // entire archive.
            _logger.LogWarning("Export skipped missing blob for shard {ShardId} ({StorageKey})", shard.Id, shard.StorageKey);
            var marker = zip.CreateEntry(entryName + ".missing", CompressionLevel.NoCompression);
            await using var ms = marker.Open();
            // intentionally empty
            await ms.FlushAsync(ct);
            return false;
        }

        try
        {
            // Shards are XChaCha20-Poly1305 ciphertext — already random.
            // Setting CompressionLevel.NoCompression saves CPU and avoids
            // the well-known "deflate makes ciphertext bigger" anti-pattern.
            var entry = zip.CreateEntry(entryName, CompressionLevel.NoCompression);
            await using var entryStream = entry.Open();
            await source.CopyToAsync(entryStream, 81920, ct);
            return true;
        }
        finally
        {
            await source.DisposeAsync();
        }
    }

    private static async Task WriteJsonEntryAsync<T>(ZipArchive zip, string entryName, T payload, CancellationToken ct)
    {
        var entry = zip.CreateEntry(entryName, CompressionLevel.Fastest);
        await using var entryStream = entry.Open();
        await JsonSerializer.SerializeAsync(entryStream, payload, JsonOptions, ct);
    }

    private static async Task WriteBytesEntryAsync(ZipArchive zip, string entryName, byte[] bytes, CancellationToken ct)
    {
        // CompressionLevel.NoCompression because all byte[] payloads in the
        // export are either ciphertext or signed bytes — already high-entropy.
        var entry = zip.CreateEntry(entryName, CompressionLevel.NoCompression);
        await using var entryStream = entry.Open();
        await entryStream.WriteAsync(bytes.AsMemory(), ct);
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
    };
}
