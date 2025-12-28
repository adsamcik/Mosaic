using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class QuotaSettingsServiceTests
{
    private MosaicDbContext CreateDb()
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new MosaicDbContext(options);
    }

    private IConfiguration CreateConfig(
        long maxBytes = 10737418240,
        int maxAlbums = 100,
        int maxPhotos = 10000,
        long maxAlbumSize = 5368709120)
    {
        return new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Quota:DefaultMaxBytes"] = maxBytes.ToString(),
                ["Quota:DefaultMaxAlbums"] = maxAlbums.ToString(),
                ["Quota:DefaultMaxPhotosPerAlbum"] = maxPhotos.ToString(),
                ["Quota:DefaultMaxBytesPerAlbum"] = maxAlbumSize.ToString()
            })
            .Build();
    }

    [Fact]
    public async Task GetDefaultsAsync_ReturnsConfigDefaults_WhenNoDbSetting()
    {
        var db = CreateDb();
        var config = CreateConfig(maxBytes: 5_000_000, maxAlbums: 50);
        var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);

        var defaults = await service.GetDefaultsAsync();

        Assert.Equal(5_000_000, defaults.MaxStorageBytesPerUser);
        Assert.Equal(50, defaults.MaxAlbumsPerUser);
    }

    [Fact]
    public async Task GetDefaultsAsync_ReturnsDbDefaults_WhenDbSettingExists()
    {
        var db = CreateDb();
        var config = CreateConfig();
        var cache = new MemoryCache(new MemoryCacheOptions());

        // Set up DB setting
        db.SystemSettings.Add(new SystemSetting
        {
            Key = "quota.defaults",
            Value = """{"MaxStorageBytesPerUser":1000,"MaxAlbumsPerUser":10,"MaxPhotosPerAlbum":100,"MaxBytesPerAlbum":500}"""
        });
        await db.SaveChangesAsync();

        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);
        var defaults = await service.GetDefaultsAsync();

        Assert.Equal(1000, defaults.MaxStorageBytesPerUser);
        Assert.Equal(10, defaults.MaxAlbumsPerUser);
        Assert.Equal(100, defaults.MaxPhotosPerAlbum);
        Assert.Equal(500, defaults.MaxBytesPerAlbum);
    }

    [Fact]
    public async Task SetDefaultsAsync_PersistsToDb()
    {
        var db = CreateDb();
        var config = CreateConfig();
        var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);

        var userId = Guid.NewGuid();
        var newDefaults = new QuotaDefaults(2000, 20, 200, 1000);

        await service.SetDefaultsAsync(newDefaults, userId);

        var setting = await db.SystemSettings.FindAsync("quota.defaults");
        Assert.NotNull(setting);
        Assert.Equal(userId, setting.UpdatedBy);
    }

    [Fact]
    public async Task GetEffectiveMaxStorageBytesAsync_ReturnsUserOverride_WhenSet()
    {
        var db = CreateDb();
        var config = CreateConfig(maxBytes: 1000);
        var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);

        var userId = Guid.NewGuid();
        db.UserQuotas.Add(new UserQuota { UserId = userId, MaxStorageBytes = 5000 });
        await db.SaveChangesAsync();

        var result = await service.GetEffectiveMaxStorageBytesAsync(userId);

        Assert.Equal(5000, result);
    }

    [Fact]
    public async Task GetEffectiveMaxAlbumsAsync_ReturnsDefault_WhenNoOverride()
    {
        var db = CreateDb();
        var config = CreateConfig(maxAlbums: 75);
        var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);

        var userId = Guid.NewGuid();
        db.UserQuotas.Add(new UserQuota { UserId = userId, MaxStorageBytes = 1000, MaxAlbums = null });
        await db.SaveChangesAsync();

        var result = await service.GetEffectiveMaxAlbumsAsync(userId);

        Assert.Equal(75, result);
    }

    [Fact]
    public async Task GetEffectiveMaxPhotosAsync_ReturnsAlbumOverride_WhenSet()
    {
        var db = CreateDb();
        var config = CreateConfig(maxPhotos: 10000);
        var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);

        var albumId = Guid.NewGuid();
        db.AlbumLimits.Add(new AlbumLimits { AlbumId = albumId, MaxPhotos = 500 });
        await db.SaveChangesAsync();

        var result = await service.GetEffectiveMaxPhotosAsync(albumId);

        Assert.Equal(500, result);
    }

    [Fact]
    public async Task GetEffectiveMaxAlbumSizeAsync_ReturnsDefault_WhenNoOverride()
    {
        var db = CreateDb();
        var config = CreateConfig(maxAlbumSize: 9999);
        var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);

        var albumId = Guid.NewGuid();

        var result = await service.GetEffectiveMaxAlbumSizeAsync(albumId);

        Assert.Equal(9999, result);
    }
}
