using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/manifests")]
public class ManifestsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ICurrentUserService _currentUserService;
    private readonly ILogger<ManifestsController> _logger;
    private readonly bool _useSqlite;

    public ManifestsController(
        MosaicDbContext db,
        IConfiguration config,
        IQuotaSettingsService quotaService,
        ICurrentUserService currentUserService,
        ILogger<ManifestsController> logger)
    {
        _db = db;
        _config = config;
        _quotaService = quotaService;
        _currentUserService = currentUserService;
        _logger = logger;

        // Detect if we're using SQLite (no row locking support)
        var connectionString = config.GetConnectionString("Default");
        _useSqlite = connectionString?.StartsWith("Data Source=", StringComparison.OrdinalIgnoreCase) ?? false;
    }

    public record CreateManifestRequest(
        Guid AlbumId,
        byte[] EncryptedMeta,
        string Signature,
        string SignerPubkey,
        List<string> ShardIds,
        /// <summary>
        /// Optional tier for all shards. Defaults to 3 (Original) if not provided.
        /// Use TieredShards for per-shard tier assignment.
        /// </summary>
        int? Tier = null,
        /// <summary>
        /// Optional list of shards with per-shard tier assignment.
        /// If provided, takes precedence over ShardIds.
        /// </summary>
        List<TieredShardInfo>? TieredShards = null
    );

    /// <summary>
    /// Shard info with tier assignment
    /// </summary>
    public record TieredShardInfo(string ShardId, int Tier);

    /// <summary>
    /// Create a new manifest (photo) in an album
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateManifestRequest request)
    {
        // Build shard info list with tiers - support both legacy ShardIds and new TieredShards
        var shardInfoList = new List<(Guid Id, int Tier)>();

        if (request.TieredShards != null && request.TieredShards.Count > 0)
        {
            // New format: per-shard tier assignment
            foreach (var tieredShard in request.TieredShards)
            {
                if (!Guid.TryParse(tieredShard.ShardId, out var shardGuid))
                {
                    _logger.LogWarning("Invalid shard ID format: {ShardId}", tieredShard.ShardId);
                    return BadRequest($"Invalid shard ID format: {tieredShard.ShardId}");
                }
                shardInfoList.Add((shardGuid, tieredShard.Tier));
            }
        }
        else
        {
            // Legacy format: all shards share the same tier
            var defaultTier = request.Tier ?? (int)ShardTier.Original;
            foreach (var shardIdStr in request.ShardIds)
            {
                if (!Guid.TryParse(shardIdStr, out var shardGuid))
                {
                    _logger.LogWarning("Invalid shard ID format: {ShardId}", shardIdStr);
                    return BadRequest($"Invalid shard ID format: {shardIdStr}");
                }
                shardInfoList.Add((shardGuid, defaultTier));
            }
        }

        var shardGuids = shardInfoList.Select(s => s.Id).ToList();

        _logger.LogInformation("Creating manifest for album {AlbumId}, shardIds count: {Count}, shardIds: {ShardIds}",
            request.AlbumId, shardGuids.Count, string.Join(",", shardGuids));

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // 1. Lock album row (FOR UPDATE is PostgreSQL-only; SQLite uses simpler locking)
            Album? album;
            if (_useSqlite)
            {
                // SQLite: Use standard query (transactions provide sufficient isolation)
                album = await _db.Albums.FindAsync(request.AlbumId);
            }
            else
            {
                // PostgreSQL: Use row-level locking for concurrent safety
                album = await _db.Albums
                    .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", request.AlbumId)
                    .FirstOrDefaultAsync();
            }

            if (album == null)
            {
                return NotFound("Album not found");
            }

            // 2. Verify membership
            var membership = await _db.AlbumMembers
                .FirstOrDefaultAsync(am =>
                    am.AlbumId == album.Id &&
                    am.UserId == user.Id &&
                    am.RevokedAt == null);

            if (membership == null)
            {
                return Forbid();
            }

            if (membership.Role == "viewer")
            {
                return Forbid();
            }

            // 3. Validate shards
            var shards = await _db.Shards
                .Where(s => shardGuids.Contains(s.Id))
                .ToListAsync();

            if (shards.Count != shardGuids.Count)
            {
                _logger.LogWarning("Shards not found: requested {Requested}, found {Found}. Missing: {Missing}",
                    shardGuids.Count, shards.Count,
                    string.Join(",", shardGuids.Except(shards.Select(s => s.Id))));
                return BadRequest("Some shards not found");
            }

            if (shards.Any(s => s.UploaderId != user.Id))
            {
                _logger.LogWarning("Shard ownership mismatch: user {UserId}, shards belong to {UploaderIds}",
                    user.Id, string.Join(",", shards.Select(s => s.UploaderId)));
                return Forbid();
            }

            if (shards.Any(s => s.Status != ShardStatus.PENDING))
            {
                var nonPending = shards.Where(s => s.Status != ShardStatus.PENDING);
                _logger.LogWarning("Shards already linked: {Shards}",
                    string.Join(",", nonPending.Select(s => $"{s.Id}={s.Status}")));
                return BadRequest("Some shards already linked to a manifest");
            }

            // 4. Check album limits
            var albumLimits = await _db.AlbumLimits.FindAsync(album.Id);
            var maxPhotos = await _quotaService.GetEffectiveMaxPhotosAsync(album.Id);
            var maxSize = await _quotaService.GetEffectiveMaxAlbumSizeAsync(album.Id);
            var shardsTotalSize = shards.Sum(s => s.SizeBytes);

            var currentPhotoCount = albumLimits?.CurrentPhotoCount ?? 0;
            var currentSizeBytes = albumLimits?.CurrentSizeBytes ?? 0;

            if (currentPhotoCount >= maxPhotos)
            {
                _logger.PhotoCountLimitExceeded(album.Id, currentPhotoCount, maxPhotos);
                return BadRequest(new { error = "ALBUM_PHOTOS_EXCEEDED", message = $"Album photo limit ({maxPhotos}) reached" });
            }

            if (currentSizeBytes + shardsTotalSize > maxSize)
            {
                _logger.PhotoSizeLimitExceeded(album.Id, currentSizeBytes + shardsTotalSize, maxSize);
                return BadRequest(new { error = "ALBUM_SIZE_EXCEEDED", message = "Album size limit exceeded" });
            }

            // 5. Create manifest
            album.CurrentVersion++;
            album.UpdatedAt = DateTime.UtcNow;

            var manifest = new Manifest
            {
                Id = Guid.CreateVersion7(),
                AlbumId = album.Id,
                VersionCreated = album.CurrentVersion,
                EncryptedMeta = request.EncryptedMeta,
                Signature = request.Signature,
                SignerPubkey = request.SignerPubkey
            };
            _db.Manifests.Add(manifest);

            // 6. Link shards and mark ACTIVE
            for (int i = 0; i < shardInfoList.Count; i++)
            {
                var (shardId, tier) = shardInfoList[i];
                var shard = shards.First(s => s.Id == shardId);
                shard.Status = ShardStatus.ACTIVE;
                shard.StatusUpdatedAt = DateTime.UtcNow;
                shard.PendingExpiresAt = null;

                _db.ManifestShards.Add(new ManifestShard
                {
                    ManifestId = manifest.Id,
                    ShardId = shard.Id,
                    ChunkIndex = i,
                    Tier = tier
                });
            }

            // 7. Update album limits tracking
            if (albumLimits != null)
            {
                albumLimits.CurrentPhotoCount++;
                albumLimits.CurrentSizeBytes += shardsTotalSize;
                albumLimits.UpdatedAt = DateTime.UtcNow;
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

            return Created($"/api/manifests/{manifest.Id}", new
            {
                manifest.Id,
                Version = album.CurrentVersion
            });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Get a specific manifest
    /// </summary>
    [HttpGet("{manifestId}")]
    public async Task<IActionResult> Get(Guid manifestId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var manifest = await _db.Manifests
            .Include(m => m.ManifestShards.OrderBy(ms => ms.ChunkIndex))
            .FirstOrDefaultAsync(m => m.Id == manifestId);

        if (manifest == null)
        {
            return NotFound();
        }

        // Verify access
        var hasAccess = await _db.AlbumMembers
            .AnyAsync(am =>
                am.AlbumId == manifest.AlbumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null);

        if (!hasAccess)
        {
            return Forbid();
        }

        return Ok(new
        {
            manifest.Id,
            manifest.AlbumId,
            manifest.VersionCreated,
            manifest.IsDeleted,
            manifest.EncryptedMeta,
            manifest.Signature,
            manifest.SignerPubkey,
            // Legacy format for backward compatibility
            ShardIds = manifest.ManifestShards.Select(ms => ms.ShardId),
            // New format with tier info
            Shards = manifest.ManifestShards.Select(ms => new { ms.ShardId, ms.Tier }),
            manifest.CreatedAt,
            manifest.UpdatedAt
        });
    }

    /// <summary>
    /// Soft-delete a manifest
    /// </summary>
    [HttpDelete("{manifestId}")]
    public async Task<IActionResult> Delete(Guid manifestId)
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
            if (_useSqlite)
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
            var membership = await _db.AlbumMembers
                .FirstOrDefaultAsync(am =>
                    am.AlbumId == album.Id &&
                    am.UserId == user.Id &&
                    am.RevokedAt == null);

            if (membership == null)
            {
                return Forbid();
            }

            if (membership.Role == "viewer")
            {
                return Forbid();
            }

            // Soft delete
            manifest.IsDeleted = true;
            manifest.UpdatedAt = DateTime.UtcNow;
            album.CurrentVersion++;
            album.UpdatedAt = DateTime.UtcNow;

            // Mark associated shards as TRASHED
            var shardIds = await _db.ManifestShards
                .Where(ms => ms.ManifestId == manifestId)
                .Select(ms => ms.ShardId)
                .ToListAsync();

            await _db.Shards
                .Where(s => shardIds.Contains(s.Id))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(x => x.Status, ShardStatus.TRASHED)
                    .SetProperty(x => x.StatusUpdatedAt, DateTime.UtcNow));

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
}
