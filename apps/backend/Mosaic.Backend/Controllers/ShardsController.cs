using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Shards;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/v1/shards")]
public class ShardsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;
    private readonly ICurrentUserService _currentUserService;
    private readonly TimeProvider _timeProvider;

    public ShardsController(
        MosaicDbContext db,
        IStorageService storage,
        ICurrentUserService currentUserService,
        TimeProvider? timeProvider = null)
    {
        _db = db;
        _storage = storage;
        _currentUserService = currentUserService;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    /// <summary>
    /// Download an encrypted shard
    /// </summary>
    [HttpGet("{shardId}")]
    public async Task<IActionResult> Download(Guid shardId)
    {
        if (HttpContext.Items["AuthSub"] is not string)
        {
            return Unauthorized();
        }

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

        var access = await GetMemberAccessAsync(shardId, user.Id);
        if (!access.HasMemberReference)
        {
            return Forbid();
        }

        if (!access.HasUnexpiredMemberAccess)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store, no-cache, max-age=0";
        Response.Headers.Pragma = "no-cache";
        Response.Headers.Expires = "0";

        // Add SHA256 for client-side integrity verification
        if (!string.IsNullOrEmpty(shard.Sha256))
        {
            Response.Headers["X-Content-SHA256"] = shard.Sha256;
        }

        try
        {
            var stream = await _storage.OpenReadAsync(shard.StorageKey);
            return File(stream, "application/octet-stream");
        }
        catch (ShardMissingException)
        {
            // Blob was purged from local storage (likely trashed by GC). Translate
            // ENOENT to an authoritative 410 instead of a generic 500 (v1.0.1 s20).
            return StatusCode(StatusCodes.Status410Gone, new { code = "TRASHED" });
        }
    }

    /// <summary>
    /// Get shard metadata
    /// </summary>
    [HttpGet("{shardId}/meta")]
    [ProducesResponseType<ShardMetadataResponse>(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetMeta(Guid shardId)
    {
        if (HttpContext.Items["AuthSub"] is not string)
        {
            return Unauthorized();
        }

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shard = await _db.Shards.FindAsync(shardId);
        if (shard == null)
        {
            return NotFound();
        }

        if (shard.Status == ShardStatus.ACTIVE)
        {
            var access = await GetMemberAccessAsync(shardId, user.Id);
            if (!access.HasMemberReference)
            {
                return Forbid();
            }

            if (!access.HasUnexpiredMemberAccess)
            {
                return NotFound();
            }
        }
        else if (shard.UploaderId != user.Id)
        {
            return Forbid();
        }

        return Ok(new ShardMetadataResponse(
            shard.Id,
            shard.SizeBytes,
            shard.Status,
            shard.StatusUpdatedAt,
            shard.Sha256));
    }

    private async Task<MemberAccessResult> GetMemberAccessAsync(Guid shardId, Guid userId)
    {
        var now = _timeProvider.GetUtcNow();
        var access = await _db.ManifestShards
            .Where(ms => ms.ShardId == shardId)
            .GroupBy(_ => 1)
            .Select(group => new MemberAccessResult(
                group.Any(ms => !ms.Manifest.IsDeleted
                    && _db.AlbumMembers.Any(am =>
                        am.AlbumId == ms.Manifest.AlbumId
                        && am.UserId == userId
                        && am.RevokedAt == null)),
                group.Any(ms => !ms.Manifest.IsDeleted
                    && (ms.Manifest.ExpiresAt == null || ms.Manifest.ExpiresAt > now)
                    && (ms.Manifest.Album.ExpiresAt == null || ms.Manifest.Album.ExpiresAt > now)
                    && _db.AlbumMembers.Any(am =>
                        am.AlbumId == ms.Manifest.AlbumId
                        && am.UserId == userId
                        && am.RevokedAt == null))))
            .SingleOrDefaultAsync();

        return access ?? new MemberAccessResult(false, false);
    }

    private sealed record MemberAccessResult(bool HasMemberReference, bool HasUnexpiredMemberAccess);
}
