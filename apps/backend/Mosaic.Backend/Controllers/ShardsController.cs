using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/shards")]
public class ShardsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;
    private readonly ICurrentUserService _currentUserService;

    public ShardsController(MosaicDbContext db, IStorageService storage, ICurrentUserService currentUserService)
    {
        _db = db;
        _storage = storage;
        _currentUserService = currentUserService;
    }

    /// <summary>
    /// Download an encrypted shard
    /// </summary>
    [HttpGet("{shardId}")]
    public async Task<IActionResult> Download(Guid shardId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shard = await _db.Shards.FindAsync(shardId);
        if (shard == null)
        {
            return NotFound();
        }

        if (shard.Status != ShardStatus.ACTIVE)
        {
            return NotFound();
        }

        // Verify user has access to at least one album containing this shard
        var hasAccess = await _db.ManifestShards
            .Where(ms => ms.ShardId == shardId)
            .AnyAsync(ms => _db.AlbumMembers.Any(am =>
                am.AlbumId == ms.Manifest.AlbumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null));

        if (!hasAccess)
        {
            return Forbid();
        }

        // Set aggressive caching headers - shards are immutable (content-addressed)
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        Response.Headers.ETag = $"\"{shardId}\"";
        
        // Add SHA256 for client-side integrity verification
        if (!string.IsNullOrEmpty(shard.Sha256))
        {
            Response.Headers["X-Content-SHA256"] = shard.Sha256;
        }

        var stream = await _storage.OpenReadAsync(shard.StorageKey);
        return File(stream, "application/octet-stream");
    }

    /// <summary>
    /// Get shard metadata
    /// </summary>
    [HttpGet("{shardId}/meta")]
    public async Task<IActionResult> GetMeta(Guid shardId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shard = await _db.Shards.FindAsync(shardId);
        if (shard == null)
        {
            return NotFound();
        }

        // Only uploader or users with access can view metadata
        if (shard.UploaderId != user.Id)
        {
            var hasAccess = await _db.ManifestShards
                .Where(ms => ms.ShardId == shardId)
                .AnyAsync(ms => _db.AlbumMembers.Any(am =>
                    am.AlbumId == ms.Manifest.AlbumId &&
                    am.UserId == user.Id &&
                    am.RevokedAt == null));

            if (!hasAccess)
            {
                return Forbid();
            }
        }

        return Ok(new
        {
            shard.Id,
            shard.SizeBytes,
            shard.Status,
            shard.StatusUpdatedAt,
            shard.Sha256
        });
    }
}
