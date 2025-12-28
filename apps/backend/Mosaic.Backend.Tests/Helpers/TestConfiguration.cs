using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Provides test configuration for controllers
/// </summary>
public static class TestConfiguration
{
    /// <summary>
    /// Creates a configuration with default quota settings
    /// </summary>
    public static IConfiguration Create(long defaultMaxBytes = 10737418240) // 10GB default
    {
        var configData = new Dictionary<string, string?>
        {
            ["Quota:DefaultMaxBytes"] = defaultMaxBytes.ToString(),
            ["Quota:DefaultMaxAlbums"] = "100",
            ["Quota:DefaultMaxPhotosPerAlbum"] = "10000",
            ["Quota:DefaultMaxBytesPerAlbum"] = "5368709120",
            ["Storage:Path"] = Path.GetTempPath()
        };

        return new ConfigurationBuilder()
            .AddInMemoryCollection(configData)
            .Build();
    }

    /// <summary>
    /// Creates a QuotaSettingsService for testing
    /// </summary>
    public static IQuotaSettingsService CreateQuotaService(MosaicDbContext db, IConfiguration? config = null)
    {
        config ??= Create();
        var cache = new MemoryCache(new MemoryCacheOptions());
        return new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);
    }
}
