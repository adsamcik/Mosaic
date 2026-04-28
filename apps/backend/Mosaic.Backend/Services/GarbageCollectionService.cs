using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Logging;

namespace Mosaic.Backend.Services;

public class GarbageCollectionService : BackgroundService
{
    internal static readonly TimeSpan ExpiredShareLinkRetention = TimeSpan.FromDays(30);
    internal static readonly TimeSpan ExpiredShareLinkGrantRetentionBuffer = TimeSpan.FromMinutes(10);

    private readonly IServiceProvider _services;
    private readonly ILogger<GarbageCollectionService> _logger;

    public GarbageCollectionService(
        IServiceProvider services,
        ILogger<GarbageCollectionService> logger)
    {
        _services = services;
        _logger = logger;

    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait a bit before starting GC cycles
        await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _logger.GarbageCollectionStarted();

                var orphanedBlobs = 0;
                var expiredSessions = 0;
                var expiredLinks = 0;
                var expiredAlbums = 0;
                var expiredUploadReservations = 0;

                expiredUploadReservations = await TusEventHandlers.CleanupExpiredReservations(_services, stoppingToken);
                orphanedBlobs = await CleanExpiredPendingShards();
                orphanedBlobs += await CleanTrashedShards(stoppingToken);
                expiredAlbums = await CleanExpiredAlbums();
                await CleanExpiredShareLinkGrants();
                expiredLinks = await CleanExpiredShareLinks();

                _logger.GarbageCollectionCompleted(
                    orphanedBlobs + expiredUploadReservations,
                    expiredSessions,
                    expiredLinks,
                    expiredAlbums);
            }
            catch (Exception ex)
            {
                _logger.GarbageCollectionFailed(ex);
            }

            await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
        }
    }

    private async Task<int> CleanExpiredPendingShards()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        // Use parameterized SQL with database-specific NOW function
        int count;
        if (db.UsesLiteProvider())
        {
            count = await db.Database.ExecuteSqlAsync(
                $"UPDATE shards SET status = 'TRASHED', status_updated_at = datetime('now') WHERE status = 'PENDING' AND pending_expires_at < datetime('now')");
        }
        else
        {
            count = await db.Database.ExecuteSqlAsync(
                $"UPDATE shards SET status = 'TRASHED', status_updated_at = NOW() WHERE status = 'PENDING' AND pending_expires_at < NOW()");
        }

        if (count > 0)
        {
            _logger.OrphanedBlobsCleaned(count);
        }

        return count;
    }

    internal async Task<int> CleanTrashedShards(CancellationToken cancellationToken = default)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

        var totalDeleted = 0;
        var cutoff = DateTime.UtcNow.AddDays(-7);

        while (!cancellationToken.IsCancellationRequested)
        {
            var toDelete = await db.Shards
                .Where(s => s.Status == ShardStatus.TRASHED
                         && s.StatusUpdatedAt < cutoff)
                .OrderBy(s => s.StatusUpdatedAt)
                .Take(100)  // Batch to avoid long transactions
                .ToListAsync(cancellationToken);

            if (toDelete.Count == 0)
            {
                break;
            }

            // Delete storage files in parallel (max 10 concurrent)
            var semaphore = new SemaphoreSlim(10);
            var deleteTasks = toDelete.Select(async shard =>
            {
                await semaphore.WaitAsync(cancellationToken);
                try
                {
                    await storage.DeleteAsync(shard.StorageKey);
                    return (shard, success: true);
                }
                catch (Exception ex)
                {
                    _logger.StorageError(ex, $"delete shard {shard.Id}");
                    return (shard, success: false);
                }
                finally
                {
                    semaphore.Release();
                }
            }).ToList();

            var results = await Task.WhenAll(deleteTasks);
            var successfulShards = results.Where(r => r.success).Select(r => r.shard).ToList();

            if (successfulShards.Count == 0)
            {
                break;
            }

            // Batch update database for successful deletes
            var now = DateTime.UtcNow;

            foreach (var shard in successfulShards)
            {
                // Reclaim quota
                if (shard.UploaderId.HasValue)
                {
                    if (db.Database.IsRelational())
                    {
                        if (db.UsesLiteProvider())
                        {
                            await db.Database.ExecuteSqlAsync(
                                $"UPDATE user_quotas SET used_storage_bytes = MAX(0, used_storage_bytes - {shard.SizeBytes}), updated_at = {now} WHERE user_id = {shard.UploaderId.Value}");
                        }
                        else
                        {
                            await db.Database.ExecuteSqlAsync(
                                $"UPDATE user_quotas SET used_storage_bytes = GREATEST(0, used_storage_bytes - {shard.SizeBytes}), updated_at = {now} WHERE user_id = {shard.UploaderId.Value}");
                        }
                    }
                    else
                    {
                        var quota = await db.UserQuotas.FindAsync(shard.UploaderId.Value);
                        if (quota != null)
                        {
                            quota.UsedStorageBytes = Math.Max(0, quota.UsedStorageBytes - shard.SizeBytes);
                            quota.UpdatedAt = now;
                        }
                    }
                }

                db.Shards.Remove(shard);
            }

            await db.SaveChangesAsync(cancellationToken);
            totalDeleted += successfulShards.Count;
        }

        return totalDeleted;
    }

    internal async Task<int> CleanExpiredAlbums()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var now = DateTimeOffset.UtcNow;

        var deletedCount = 0;

        // Process expired albums in batches of 10
        while (true)
        {
            List<Album> expiredAlbums;

            if (db.UsesLiteProvider())
            {
                // SQLite doesn't support DateTimeOffset in WHERE or ORDER BY clauses,
                // so we load albums with expiration dates and filter/sort client-side.
                // This is acceptable for garbage collection on small datasets.
                expiredAlbums = (await db.Albums
                    .Where(a => a.ExpiresAt != null)
                    .ToListAsync())
                    .Where(a => a.ExpiresAt <= now)
                    .OrderBy(a => a.ExpiresAt)
                    .Take(10)
                    .ToList();
            }
            else
            {
                // PostgreSQL supports server-side DateTimeOffset filtering - much more efficient
                expiredAlbums = await db.Albums
                    .Where(a => a.ExpiresAt != null && a.ExpiresAt <= now)
                    .OrderBy(a => a.ExpiresAt)
                    .Take(10)
                    .ToListAsync();
            }

            if (expiredAlbums.Count == 0)
            {
                break;
            }

            foreach (var album in expiredAlbums)
            {
                try
                {
                    var manifestIds = await db.Manifests
                        .IgnoreQueryFilters()
                        .Where(m => m.AlbumId == album.Id)
                        .Select(m => m.Id)
                        .ToListAsync();

                    await ShardReferenceCleanup.DetachManifestShardsAsync(db, manifestIds, DateTime.UtcNow);

                    var quota = await db.UserQuotas.FindAsync(album.OwnerId);
                    if (quota != null)
                    {
                        quota.CurrentAlbumCount = Math.Max(0, quota.CurrentAlbumCount - 1);
                        quota.UpdatedAt = DateTime.UtcNow;
                    }

                    db.Albums.Remove(album);
                    await db.SaveChangesAsync();

                    _logger.ExpiredAlbumsCleaned(1);
                    deletedCount++;
                }
                catch (Exception ex)
                {
                    _logger.DatabaseError(ex, $"delete expired album {album.Id}");
                }
            }
        }

        return deletedCount;
    }

    internal async Task<int> CleanExpiredShareLinks()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var expirationCutoff = DateTimeOffset.UtcNow.Subtract(ExpiredShareLinkRetention);
        var totalDeleted = 0;

        // Delete share links that expired 30+ days ago in batches
        while (true)
        {
            List<ShareLink> longExpiredLinks;

            if (db.UsesLiteProvider())
            {
                longExpiredLinks = (await db.ShareLinks
                    .Where(sl => sl.ExpiresAt != null)
                    .ToListAsync())
                    .Where(sl => sl.ExpiresAt <= expirationCutoff)
                    .OrderBy(sl => sl.ExpiresAt)
                    .Take(100)
                    .ToList();
            }
            else
            {
                longExpiredLinks = await db.ShareLinks
                    .Where(sl => sl.ExpiresAt != null && sl.ExpiresAt <= expirationCutoff)
                    .OrderBy(sl => sl.ExpiresAt)
                    .Take(100)
                    .ToListAsync();
            }

            if (longExpiredLinks.Count == 0)
            {
                break;
            }

            db.ShareLinks.RemoveRange(longExpiredLinks);
            await db.SaveChangesAsync();

            totalDeleted += longExpiredLinks.Count;
            _logger.ExpiredLinksCleaned(longExpiredLinks.Count);
        }

        return totalDeleted;
    }

    internal async Task<int> CleanExpiredShareLinkGrants()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var expirationCutoff = DateTimeOffset.UtcNow.Subtract(ExpiredShareLinkGrantRetentionBuffer);
        var totalDeleted = 0;

        while (true)
        {
            List<ShareLinkGrant> expiredGrants;

            if (db.UsesLiteProvider())
            {
                expiredGrants = (await db.ShareLinkGrants.ToListAsync())
                    .Where(grant => grant.ExpiresAt <= expirationCutoff)
                    .OrderBy(grant => grant.ExpiresAt)
                    .Take(100)
                    .ToList();
            }
            else
            {
                expiredGrants = await db.ShareLinkGrants
                    .Where(grant => grant.ExpiresAt <= expirationCutoff)
                    .OrderBy(grant => grant.ExpiresAt)
                    .Take(100)
                    .ToListAsync();
            }

            if (expiredGrants.Count == 0)
            {
                break;
            }

            db.ShareLinkGrants.RemoveRange(expiredGrants);
            await db.SaveChangesAsync();
            totalDeleted += expiredGrants.Count;
        }

        return totalDeleted;
    }
}
