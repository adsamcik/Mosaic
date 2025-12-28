using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/manifests")]
public class ManifestsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ILogger<ManifestsController> _logger;

    public ManifestsController(
        MosaicDbContext db,
        IConfiguration config,
        IQuotaSettingsService quotaService,
        ILogger<ManifestsController> logger)
    {
        _db = db;
        _config = config;
        _quotaService = quotaService;
        _logger = logger;
    }

    private async Task<User?> GetUser()
    {
        var authSub = HttpContext.Items["AuthSub"] as string;
        if (authSub == null) return null;
        return await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
    }

    public record CreateManifestRequest(
        Guid AlbumId,
        byte[] EncryptedMeta,
        string Signature,
        string SignerPubkey,
        List<Guid> ShardIds
    );

    /// <summary>
    /// Create a new manifest (photo) in an album
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateManifestRequest request)
    {
        var user = await GetUser();
        if (user == null) return Unauthorized();

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // 1. Lock album row
            var album = await _db.Albums
                .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", request.AlbumId)
                .FirstOrDefaultAsync();

            if (album == null) return NotFound("Album not found");

            // 2. Verify membership
            var membership = await _db.AlbumMembers
                .FirstOrDefaultAsync(am =>
                    am.AlbumId == album.Id &&
                    am.UserId == user.Id &&
                    am.RevokedAt == null);

            if (membership == null) return Forbid();
            if (membership.Role == "viewer") return Forbid();

            // 3. Validate shards
            var shards = await _db.Shards
                .Where(s => request.ShardIds.Contains(s.Id))
                .ToListAsync();

            if (shards.Count != request.ShardIds.Count)
                return BadRequest("Some shards not found");

            if (shards.Any(s => s.UploaderId != user.Id))
                return Forbid();

            if (shards.Any(s => s.Status != ShardStatus.PENDING))
                return BadRequest("Some shards already linked to a manifest");

            // 4. Check album limits
            var albumLimits = await _db.AlbumLimits.FindAsync(album.Id);
            var maxPhotos = await _quotaService.GetEffectiveMaxPhotosAsync(album.Id);
            var maxSize = await _quotaService.GetEffectiveMaxAlbumSizeAsync(album.Id);
            var shardsTotalSize = shards.Sum(s => s.SizeBytes);

            var currentPhotoCount = albumLimits?.CurrentPhotoCount ?? 0;
            var currentSizeBytes = albumLimits?.CurrentSizeBytes ?? 0;

            if (currentPhotoCount >= maxPhotos)
            {
                _logger.LogWarning("Album {AlbumId} photo limit exceeded: {Current}/{Max}", album.Id, currentPhotoCount, maxPhotos);
                return BadRequest(new { error = "ALBUM_PHOTOS_EXCEEDED", message = $"Album photo limit ({maxPhotos}) reached" });
            }

            if (currentSizeBytes + shardsTotalSize > maxSize)
            {
                _logger.LogWarning("Album {AlbumId} size limit exceeded: {Current}+{New}/{Max}", album.Id, currentSizeBytes, shardsTotalSize, maxSize);
                return BadRequest(new { error = "ALBUM_SIZE_EXCEEDED", message = "Album size limit exceeded" });
            }

            // 5. Create manifest
            album.CurrentVersion++;
            album.UpdatedAt = DateTime.UtcNow;

            var manifest = new Manifest
            {
                Id = Guid.NewGuid(),
                AlbumId = album.Id,
                VersionCreated = album.CurrentVersion,
                EncryptedMeta = request.EncryptedMeta,
                Signature = request.Signature,
                SignerPubkey = request.SignerPubkey
            };
            _db.Manifests.Add(manifest);

            // 6. Link shards and mark ACTIVE
            for (int i = 0; i < request.ShardIds.Count; i++)
            {
                var shard = shards.First(s => s.Id == request.ShardIds[i]);
                shard.Status = ShardStatus.ACTIVE;
                shard.StatusUpdatedAt = DateTime.UtcNow;
                shard.PendingExpiresAt = null;

                _db.ManifestShards.Add(new ManifestShard
                {
                    ManifestId = manifest.Id,
                    ShardId = shard.Id,
                    ChunkIndex = i
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
        var user = await GetUser();
        if (user == null) return Unauthorized();

        var manifest = await _db.Manifests
            .Include(m => m.ManifestShards.OrderBy(ms => ms.ChunkIndex))
            .FirstOrDefaultAsync(m => m.Id == manifestId);

        if (manifest == null) return NotFound();

        // Verify access
        var hasAccess = await _db.AlbumMembers
            .AnyAsync(am =>
                am.AlbumId == manifest.AlbumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null);

        if (!hasAccess) return Forbid();

        return Ok(new
        {
            manifest.Id,
            manifest.AlbumId,
            manifest.VersionCreated,
            manifest.IsDeleted,
            manifest.EncryptedMeta,
            manifest.Signature,
            manifest.SignerPubkey,
            ShardIds = manifest.ManifestShards.Select(ms => ms.ShardId),
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
        var user = await GetUser();
        if (user == null) return Unauthorized();

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var manifest = await _db.Manifests.FindAsync(manifestId);
            if (manifest == null) return NotFound();

            // Lock album
            var album = await _db.Albums
                .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", manifest.AlbumId)
                .FirstOrDefaultAsync();

            if (album == null) return NotFound();

            // Verify editor/owner access
            var membership = await _db.AlbumMembers
                .FirstOrDefaultAsync(am =>
                    am.AlbumId == album.Id &&
                    am.UserId == user.Id &&
                    am.RevokedAt == null);

            if (membership == null) return Forbid();
            if (membership.Role == "viewer") return Forbid();

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
