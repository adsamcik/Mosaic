using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;

namespace Mosaic.Backend.Services;

public interface IAlbumExpirationService
{
    DateTimeOffset UtcNow { get; }
    bool IsExpired(DateTimeOffset? expiresAt);
    Task<bool> EnforceAlbumExpirationAsync(Guid albumId, CancellationToken cancellationToken = default);
    Task<bool> EnforceManifestExpirationAsync(Guid manifestId, CancellationToken cancellationToken = default);
    Task<int> SweepExpiredAlbumsAsync(CancellationToken cancellationToken = default);
    Task<int> SweepExpiredManifestsAsync(Guid? albumId = null, CancellationToken cancellationToken = default);
}

public sealed class AlbumExpirationService : IAlbumExpirationService
{
    private const int AlbumBatchSize = 10;
    private const int ManifestBatchSize = 100;

    private readonly MosaicDbContext _db;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<AlbumExpirationService> _logger;

    public AlbumExpirationService(
        MosaicDbContext db,
        TimeProvider timeProvider,
        ILogger<AlbumExpirationService> logger)
    {
        _db = db;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public DateTimeOffset UtcNow => _timeProvider.GetUtcNow();

    public bool IsExpired(DateTimeOffset? expiresAt)
        => expiresAt.HasValue && expiresAt.Value <= UtcNow;

    public async Task<bool> EnforceAlbumExpirationAsync(Guid albumId, CancellationToken cancellationToken = default)
    {
        var album = await _db.Albums.FirstOrDefaultAsync(a => a.Id == albumId, cancellationToken);
        if (album == null || !IsExpired(album.ExpiresAt))
        {
            return false;
        }

        await DeleteExpiredAlbumAsync(album, cancellationToken);
        return true;
    }

    public async Task<bool> EnforceManifestExpirationAsync(Guid manifestId, CancellationToken cancellationToken = default)
    {
        var manifest = await _db.Manifests
            .IgnoreQueryFilters()
            .Include(m => m.Album)
            .FirstOrDefaultAsync(m => m.Id == manifestId, cancellationToken);

        if (manifest == null)
        {
            return false;
        }

        if (IsExpired(manifest.Album.ExpiresAt))
        {
            await DeleteExpiredAlbumAsync(manifest.Album, cancellationToken);
            return true;
        }

        if (manifest.IsDeleted || !IsExpired(manifest.ExpiresAt))
        {
            return false;
        }

        await DeleteExpiredManifestAsync(manifest, cancellationToken);
        return true;
    }

    public async Task<int> SweepExpiredAlbumsAsync(CancellationToken cancellationToken = default)
    {
        var deletedCount = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            var expiredAlbums = await QueryExpiredAlbumsAsync(cancellationToken);
            if (expiredAlbums.Count == 0)
            {
                break;
            }

            foreach (var album in expiredAlbums)
            {
                try
                {
                    await DeleteExpiredAlbumAsync(album, cancellationToken);
                    deletedCount++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Failed to expire album {AlbumId}", album.Id);
                }
            }
        }

        return deletedCount;
    }

    public async Task<int> SweepExpiredManifestsAsync(Guid? albumId = null, CancellationToken cancellationToken = default)
    {
        var deletedCount = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            var expiredManifests = await QueryExpiredManifestsAsync(albumId, cancellationToken);
            if (expiredManifests.Count == 0)
            {
                break;
            }

            foreach (var manifest in expiredManifests)
            {
                try
                {
                    if (manifest.Album == null || IsExpired(manifest.Album.ExpiresAt))
                    {
                        continue;
                    }

                    await DeleteExpiredManifestAsync(manifest, cancellationToken);
                    deletedCount++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Failed to expire manifest {ManifestId}", manifest.Id);
                }
            }
        }

        return deletedCount;
    }

    private async Task<List<Album>> QueryExpiredAlbumsAsync(CancellationToken cancellationToken)
    {
        var now = UtcNow;

        if (_db.UsesLiteProvider())
        {
            return (await _db.Albums
                    .Where(a => a.ExpiresAt != null)
                    .ToListAsync(cancellationToken))
                .Where(a => a.ExpiresAt <= now)
                .OrderBy(a => a.ExpiresAt)
                .Take(AlbumBatchSize)
                .ToList();
        }

        return await _db.Albums
            .Where(a => a.ExpiresAt != null && a.ExpiresAt <= now)
            .OrderBy(a => a.ExpiresAt)
            .Take(AlbumBatchSize)
            .ToListAsync(cancellationToken);
    }

    private async Task<List<Manifest>> QueryExpiredManifestsAsync(Guid? albumId, CancellationToken cancellationToken)
    {
        var now = UtcNow;
        var query = _db.Manifests
            .IgnoreQueryFilters()
            .Include(m => m.Album)
            .Where(m => !m.IsDeleted && m.ExpiresAt != null);

        if (albumId.HasValue)
        {
            query = query.Where(m => m.AlbumId == albumId.Value);
        }

        if (_db.UsesLiteProvider())
        {
            return (await query.ToListAsync(cancellationToken))
                .Where(m => m.ExpiresAt <= now)
                .OrderBy(m => m.ExpiresAt)
                .Take(ManifestBatchSize)
                .ToList();
        }

        return await query
            .Where(m => m.ExpiresAt <= now)
            .OrderBy(m => m.ExpiresAt)
            .Take(ManifestBatchSize)
            .ToListAsync(cancellationToken);
    }

    private async Task DeleteExpiredAlbumAsync(Album album, CancellationToken cancellationToken)
    {
        var utcNow = UtcNow.UtcDateTime;
        var manifestIds = await _db.Manifests
            .IgnoreQueryFilters()
            .Where(m => m.AlbumId == album.Id)
            .Select(m => m.Id)
            .ToListAsync(cancellationToken);

        await ShardReferenceCleanup.DetachManifestShardsAsync(_db, manifestIds, utcNow, cancellationToken);

        var quota = await _db.UserQuotas.FindAsync([album.OwnerId], cancellationToken);
        if (quota != null)
        {
            quota.CurrentAlbumCount = Math.Max(0, quota.CurrentAlbumCount - 1);
            quota.UpdatedAt = utcNow;
        }

        _db.Albums.Remove(album);
        await _db.SaveChangesAsync(cancellationToken);
    }

    private async Task DeleteExpiredManifestAsync(Manifest manifest, CancellationToken cancellationToken)
    {
        var utcNow = UtcNow.UtcDateTime;
        var album = manifest.Album ?? await _db.Albums.FindAsync([manifest.AlbumId], cancellationToken);
        if (album == null)
        {
            return;
        }

        var cleanupResult = await ShardReferenceCleanup.DetachManifestShardsAsync(
            _db,
            [manifest.Id],
            utcNow,
            cancellationToken);

        album.CurrentVersion++;
        album.UpdatedAt = utcNow;
        manifest.IsDeleted = true;
        manifest.EncryptedMeta = [];
        manifest.ExpiresAt = null;
        manifest.VersionCreated = album.CurrentVersion;
        manifest.UpdatedAt = utcNow;

        var albumLimits = await _db.AlbumLimits.FindAsync([album.Id], cancellationToken);
        if (albumLimits != null)
        {
            albumLimits.CurrentPhotoCount = Math.Max(0, albumLimits.CurrentPhotoCount - 1);
            albumLimits.CurrentSizeBytes = Math.Max(0, albumLimits.CurrentSizeBytes - cleanupResult.TotalDetachedSizeBytes);
            albumLimits.UpdatedAt = utcNow;
        }

        await _db.SaveChangesAsync(cancellationToken);
    }
}
