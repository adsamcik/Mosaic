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
    private readonly TimeProvider _timeProvider;

    public GarbageCollectionService(
        IServiceProvider services,
        ILogger<GarbageCollectionService> logger,
        TimeProvider? timeProvider = null)
    {
        _services = services;
        _logger = logger;
        _timeProvider = timeProvider ?? TimeProvider.System;
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

                expiredUploadReservations = await TusEventHandlers.CleanupExpiredReservationsAsync(_services, stoppingToken);
                orphanedBlobs = await CleanExpiredPendingShardsAsync();
                orphanedBlobs += await CleanTrashedShardsAsync(stoppingToken);
                expiredAlbums = await CleanExpiredAlbumsAsync(stoppingToken);
                expiredAlbums += await CleanExpiredManifestsAsync(stoppingToken);
                await CleanExpiredShareLinkGrantsAsync();
                expiredLinks = await CleanExpiredShareLinksAsync();

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

    private async Task<int> CleanExpiredPendingShardsAsync()
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

    internal async Task<int> CleanTrashedShardsAsync(CancellationToken cancellationToken = default)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

        var totalDeleted = 0;
        var cutoff = _timeProvider.GetUtcNow().UtcDateTime.AddDays(-7);

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
            var now = _timeProvider.GetUtcNow().UtcDateTime;

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

    internal async Task<int> CleanExpiredAlbumsAsync(CancellationToken cancellationToken = default)
    {
        using var scope = _services.CreateScope();
        var expirationService = scope.ServiceProvider.GetRequiredService<IAlbumExpirationService>();
        var deletedCount = await expirationService.SweepExpiredAlbumsAsync(cancellationToken);

        if (deletedCount > 0)
        {
            _logger.ExpiredAlbumsCleaned(deletedCount);
        }

        return deletedCount;
    }

    internal async Task<int> CleanExpiredManifestsAsync(CancellationToken cancellationToken = default)
    {
        using var scope = _services.CreateScope();
        var expirationService = scope.ServiceProvider.GetRequiredService<IAlbumExpirationService>();
        return await expirationService.SweepExpiredManifestsAsync(cancellationToken: cancellationToken);
    }

    internal async Task<int> CleanExpiredShareLinksAsync()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var expirationCutoff = _timeProvider.GetUtcNow().Subtract(ExpiredShareLinkRetention);
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

    internal async Task<int> CleanExpiredShareLinkGrantsAsync()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var expirationCutoff = _timeProvider.GetUtcNow().Subtract(ExpiredShareLinkGrantRetentionBuffer);
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
