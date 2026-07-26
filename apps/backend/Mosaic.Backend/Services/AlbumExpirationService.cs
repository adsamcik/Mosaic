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

        return await DeleteExpiredAlbumAsync(album, cancellationToken);
    }

    public async Task<bool> EnforceManifestExpirationAsync(Guid manifestId, CancellationToken cancellationToken = default)
    {
        // Per-photo expiration is intentionally fail-closed until it has a
        // reservation-backed signed v2 lifecycle mutation. Historical
        // ExpiresAt values must never create unsigned tombstones. Retain this
        // compatibility entry point only to enforce the containing album's
        // independently supported expiration policy.
        var albumId = await _db.Manifests
            .IgnoreQueryFilters()
            .Where(manifest => manifest.Id == manifestId)
            .Select(manifest => (Guid?)manifest.AlbumId)
            .FirstOrDefaultAsync(cancellationToken);

        if (!albumId.HasValue)
        {
            return false;
        }

        return await EnforceAlbumExpirationAsync(albumId.Value, cancellationToken);
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
                    if (await DeleteExpiredAlbumAsync(album, cancellationToken))
                    {
                        deletedCount++;
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Failed to expire album {AlbumId}", album.Id);
                }
            }
        }

        return deletedCount;
    }

    public Task<int> SweepExpiredManifestsAsync(Guid? albumId = null, CancellationToken cancellationToken = default)
        // Compatibility no-op: automatic per-photo expiration cannot safely
        // advance the signed manifest stream without a client signature.
        => Task.FromResult(0);

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

    private async Task<bool> DeleteExpiredAlbumAsync(Album album, CancellationToken cancellationToken)
    {
        await using var transaction = await _db.Database.BeginTransactionAsync(cancellationToken);
        try
        {
            var utcNow = UtcNow.UtcDateTime;
            var ownerId = album.OwnerId;
            var manifestIds = await _db.Manifests
                .IgnoreQueryFilters()
                .Where(m => m.AlbumId == album.Id)
                .Select(m => m.Id)
                .ToListAsync(cancellationToken);

            await ShardReferenceCleanup.DetachManifestShardsAsync(_db, manifestIds, utcNow, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);

            _db.Albums.Remove(album);
            await _db.SaveChangesAsync(cancellationToken);

            var quota = await _db.UserQuotas.FindAsync([ownerId], cancellationToken);
            if (quota != null)
            {
                quota.CurrentAlbumCount = Math.Max(0, quota.CurrentAlbumCount - 1);
                quota.UpdatedAt = utcNow;
                await _db.SaveChangesAsync(cancellationToken);
            }

            await transaction.CommitAsync(cancellationToken);

            return true;
        }
        catch (DbUpdateConcurrencyException ex)
        {
            await transaction.RollbackAsync(cancellationToken);
            _db.ChangeTracker.Clear();
            _logger.LogInformation(ex, "Expired album {AlbumId} was already cleaned up concurrently", album.Id);
            return false;
        }
    }

}
