using Mosaic.Backend.Services;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Mock quota settings service for testing
/// </summary>
public class MockQuotaSettingsService : IQuotaSettingsService
{
    public long DefaultMaxStorageBytesPerUser { get; set; } = 10L * 1024 * 1024 * 1024; // 10 GB
    public int DefaultMaxAlbumsPerUser { get; set; } = 100;
    public int DefaultMaxPhotosPerAlbum { get; set; } = 10000;
    public long DefaultMaxBytesPerAlbum { get; set; } = 5L * 1024 * 1024 * 1024; // 5 GB

    public Task<QuotaDefaults> GetDefaultsAsync()
    {
        return Task.FromResult(new QuotaDefaults(
            DefaultMaxStorageBytesPerUser,
            DefaultMaxAlbumsPerUser,
            DefaultMaxPhotosPerAlbum,
            DefaultMaxBytesPerAlbum
        ));
    }

    public Task<QuotaDefaults> SetDefaultsAsync(QuotaDefaults defaults, Guid updatedBy)
    {
        DefaultMaxStorageBytesPerUser = defaults.MaxStorageBytesPerUser;
        DefaultMaxAlbumsPerUser = defaults.MaxAlbumsPerUser;
        DefaultMaxPhotosPerAlbum = defaults.MaxPhotosPerAlbum;
        DefaultMaxBytesPerAlbum = defaults.MaxBytesPerAlbum;
        return Task.FromResult(defaults);
    }

    public Task<long> GetEffectiveMaxStorageBytesAsync(Guid userId)
    {
        return Task.FromResult(DefaultMaxStorageBytesPerUser);
    }

    public Task<int> GetEffectiveMaxAlbumsAsync(Guid userId)
    {
        return Task.FromResult(DefaultMaxAlbumsPerUser);
    }

    public Task<int> GetEffectiveMaxPhotosAsync(Guid albumId)
    {
        return Task.FromResult(DefaultMaxPhotosPerAlbum);
    }

    public Task<long> GetEffectiveMaxAlbumSizeAsync(Guid albumId)
    {
        return Task.FromResult(DefaultMaxBytesPerAlbum);
    }
}
