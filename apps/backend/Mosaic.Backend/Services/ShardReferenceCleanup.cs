using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Services;

public static class ShardReferenceCleanup
{
    public sealed record CleanupResult(IReadOnlyCollection<Guid> DetachedShardIds, long TotalDetachedSizeBytes);

    public static async Task<CleanupResult> DetachManifestShardsAsync(
        MosaicDbContext db,
        IReadOnlyCollection<Guid> manifestIds,
        DateTime utcNow,
        CancellationToken cancellationToken = default)
    {
        if (manifestIds.Count == 0)
        {
            return new CleanupResult(Array.Empty<Guid>(), 0);
        }

        var manifestShardRows = await db.ManifestShards
            .Where(ms => manifestIds.Contains(ms.ManifestId))
            .ToListAsync(cancellationToken);

        if (manifestShardRows.Count == 0)
        {
            return new CleanupResult(Array.Empty<Guid>(), 0);
        }

        var shardIds = manifestShardRows
            .Select(ms => ms.ShardId)
            .Distinct()
            .ToList();

        var detachedShards = await db.Shards
            .Where(s => shardIds.Contains(s.Id))
            .ToListAsync(cancellationToken);

        db.ManifestShards.RemoveRange(manifestShardRows);

        var remainingReferencedShardIds = await db.ManifestShards
            .Where(ms => shardIds.Contains(ms.ShardId) && !manifestIds.Contains(ms.ManifestId))
            .Select(ms => ms.ShardId)
            .Distinct()
            .ToListAsync(cancellationToken);

        var orphanedShardIds = shardIds.Except(remainingReferencedShardIds).ToList();
        if (orphanedShardIds.Count > 0)
        {
            foreach (var shard in detachedShards.Where(s => orphanedShardIds.Contains(s.Id)))
            {
                shard.Status = ShardStatus.TRASHED;
                shard.StatusUpdatedAt = utcNow;
                shard.PendingExpiresAt = null;
            }
        }

        var totalDetachedSizeBytes = detachedShards
            .Where(s => shardIds.Contains(s.Id))
            .Sum(s => s.SizeBytes);

        return new CleanupResult(orphanedShardIds, totalDetachedSizeBytes);
    }
}
