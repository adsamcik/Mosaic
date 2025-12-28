using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

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
                await CleanExpiredPendingShards();
                await CleanTrashedShards();
                await CleanExpiredAlbums();
                await CleanExpiredShareLinks();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "GC cycle failed");
            }

            await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
        }
    }

    private async Task CleanExpiredPendingShards()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        // Use database-specific NOW function
        var nowFunc = _useSqlite ? "datetime('now')" : "NOW()";
        var sql = $@"
            UPDATE shards 
            SET status = 'TRASHED', status_updated_at = {nowFunc} 
            WHERE status = 'PENDING' AND pending_expires_at < {nowFunc}";

        var count = await db.Database.ExecuteSqlRawAsync(sql);

        if (count > 0)
        {
            _logger.LogInformation("Marked {Count} expired PENDING shards as TRASHED", count);
        }
    }

    private async Task CleanTrashedShards()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

        var toDelete = await db.Shards
            .Where(s => s.Status == ShardStatus.TRASHED
                     && s.StatusUpdatedAt < DateTime.UtcNow.AddDays(-7))
            .Take(100)  // Batch to avoid long transactions
            .ToListAsync();

        // Use database-specific NOW function
        var nowFunc = _useSqlite ? "datetime('now')" : "NOW()";

        foreach (var shard in toDelete)
        {
            try
            {
                await storage.DeleteAsync(shard.StorageKey);

                // Reclaim quota
                if (shard.UploaderId.HasValue)
                {
                    await db.Database.ExecuteSqlRawAsync(
                        $"UPDATE user_quotas SET used_storage_bytes = used_storage_bytes - {{0}}, updated_at = {nowFunc} WHERE user_id = {{1}}",
                        shard.SizeBytes, shard.UploaderId.Value);
                }

                db.Shards.Remove(shard);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to delete shard {ShardId}", shard.Id);
            }
        }

        await db.SaveChangesAsync();

        if (toDelete.Count > 0)
        {
            _logger.LogInformation("Deleted {Count} TRASHED shards", toDelete.Count);
        }
    }

    private async Task CleanExpiredAlbums()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

        var now = DateTimeOffset.UtcNow;

        // Process expired albums in batches of 10
        while (true)
        {
            var expiredAlbums = await db.Albums
                .Where(a => a.ExpiresAt != null && a.ExpiresAt <= now)
                .Take(10)
                .ToListAsync();

            if (expiredAlbums.Count == 0)
                break;

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
                            _logger.LogWarning(ex, "Failed to delete shard {StorageKey} for expired album {AlbumId}", storageKey, album.Id);
                        }
                    }

                    // Remove the album from database (cascade will handle related entities)
                    db.Albums.Remove(album);
                    await db.SaveChangesAsync();

                    _logger.LogInformation("Deleted expired album {AlbumId}", album.Id);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to delete expired album {AlbumId}", album.Id);
                }
            }
        }
    }

    private async Task CleanExpiredShareLinks()
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var thirtyDaysAgo = DateTimeOffset.UtcNow.AddDays(-30);

        // Delete share links that expired 30+ days ago in batches
        while (true)
        {
            var longExpiredLinks = await db.ShareLinks
                .Where(sl => sl.ExpiresAt != null && sl.ExpiresAt <= thirtyDaysAgo)
                .Take(100)
                .ToListAsync();

            if (longExpiredLinks.Count == 0)
                break;

            db.ShareLinks.RemoveRange(longExpiredLinks);
            await db.SaveChangesAsync();

            _logger.LogInformation("Deleted {Count} long-expired share links", longExpiredLinks.Count);
        }
    }
}
