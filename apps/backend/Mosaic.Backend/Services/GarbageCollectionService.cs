using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;

namespace Mosaic.Backend.Services;

public class GarbageCollectionService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<GarbageCollectionService> _logger;
    private readonly bool _useSqlite;

    public GarbageCollectionService(
        IServiceProvider services,
        ILogger<GarbageCollectionService> logger,
        IConfiguration configuration)
    {
        _services = services;
        _logger = logger;

        var connectionString = configuration.GetConnectionString("Default");
        _useSqlite = connectionString?.StartsWith("Data Source=", StringComparison.OrdinalIgnoreCase) ?? false;
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

                orphanedBlobs = await CleanExpiredPendingShards();
                orphanedBlobs += await CleanTrashedShards();
                expiredAlbums = await CleanExpiredAlbums();
                expiredLinks = await CleanExpiredShareLinks();

                _logger.GarbageCollectionCompleted(orphanedBlobs, expiredSessions, expiredLinks, expiredAlbums);
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
        if (_useSqlite)
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

    private async Task<int> CleanTrashedShards()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

        var toDelete = await db.Shards
            .Where(s => s.Status == ShardStatus.TRASHED
                     && s.StatusUpdatedAt < DateTime.UtcNow.AddDays(-7))
            .OrderBy(s => s.StatusUpdatedAt)
            .Take(100)  // Batch to avoid long transactions
            .ToListAsync();

        if (toDelete.Count == 0)
        {
            return 0;
        }

        // Delete storage files in parallel (max 10 concurrent)
        var semaphore = new SemaphoreSlim(10);
        var deleteTasks = toDelete.Select(async shard =>
        {
            await semaphore.WaitAsync();
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

        // Batch update database for successful deletes
        var now = DateTime.UtcNow;

        foreach (var shard in successfulShards)
        {
            // Reclaim quota
            if (shard.UploaderId.HasValue)
            {
                await db.Database.ExecuteSqlAsync(
                    $"UPDATE user_quotas SET used_storage_bytes = used_storage_bytes - {shard.SizeBytes}, updated_at = {now} WHERE user_id = {shard.UploaderId.Value}");
            }

            db.Shards.Remove(shard);
        }

        await db.SaveChangesAsync();

        return successfulShards.Count;
    }

    private async Task<int> CleanExpiredAlbums()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

        var now = DateTimeOffset.UtcNow;

        var deletedCount = 0;

        // Process expired albums in batches of 10
        while (true)
        {
            List<Album> expiredAlbums;

            if (_useSqlite)
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
                    // Find all shards belonging to this album via manifests
                    var shardStorageKeys = await db.ManifestShards
                        .Where(ms => ms.Manifest.AlbumId == album.Id)
                        .Select(ms => ms.Shard.StorageKey)
                        .Distinct()
                        .ToListAsync();

                    // Delete all shards from storage
                    foreach (var storageKey in shardStorageKeys)
                    {
                        try
                        {
                            await storage.DeleteAsync(storageKey);
                        }
                        catch (Exception ex)
                        {
                            _logger.StorageError(ex, $"delete shard {storageKey} for expired album {album.Id}");
                        }
                    }

                    // Remove the album from database (cascade will handle related entities)
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

    private async Task<int> CleanExpiredShareLinks()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var thirtyDaysAgo = DateTimeOffset.UtcNow.AddDays(-30);
        var totalDeleted = 0;

        // Delete share links that expired 30+ days ago in batches
        // Note: SQLite doesn't support DateTimeOffset in WHERE or ORDER BY clauses,
        // so we load share links with expiration dates and filter/sort client-side.
        while (true)
        {
            // Load share links with expiration dates and filter/sort client-side for SQLite compatibility
            var longExpiredLinks = (await db.ShareLinks
                .Where(sl => sl.ExpiresAt != null)
                .ToListAsync())
                .Where(sl => sl.ExpiresAt <= thirtyDaysAgo)
                .OrderBy(sl => sl.ExpiresAt)
                .Take(100)
                .ToList();

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
}
