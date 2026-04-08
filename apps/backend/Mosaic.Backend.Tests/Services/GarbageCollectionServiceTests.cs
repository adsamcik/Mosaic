using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class GarbageCollectionServiceTests
{
    private static IConfiguration CreateConfig()
    {
        return new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Default"] = "Host=test;Database=test"
            })
            .Build();
    }

    private static (GarbageCollectionService service, Data.MosaicDbContext db, IStorageService storage) CreateService(
        IStorageService? storageOverride = null)
    {
        var db = TestDbContextFactory.Create();
        var storage = storageOverride ?? new MockStorageService();

        var services = new ServiceCollection();
        services.AddSingleton(db);
        services.AddSingleton(storage);
        var provider = services.BuildServiceProvider();

        var config = CreateConfig();
        var logger = new NullLogger<GarbageCollectionService>();
        var service = new GarbageCollectionService(provider, logger, config);

        return (service, db, storage);
    }

    [Fact]
    public async Task CleanExpiredAlbums_DeletesExpiredAlbum()
    {
        // Arrange
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        // Act
        var count = await service.CleanExpiredAlbums();

        // Assert
        Assert.Equal(1, count);
        Assert.Empty(db.Albums);
    }

    [Fact]
    public async Task CleanExpiredAlbums_SkipsNonExpiredAlbum()
    {
        // Arrange
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddDays(7);
        await db.SaveChangesAsync();

        // Act
        var count = await service.CleanExpiredAlbums();

        // Assert
        Assert.Equal(0, count);
        Assert.Single(db.Albums);
    }

    [Fact]
    public async Task CleanExpiredAlbums_SkipsAlbumWithNullExpiresAt()
    {
        // Arrange
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        Assert.Null(album.ExpiresAt);

        // Act
        var count = await service.CleanExpiredAlbums();

        // Assert
        Assert.Equal(0, count);
        Assert.Single(db.Albums);
    }

    [Fact]
    public async Task CleanExpiredAlbums_ReclaimsQuota()
    {
        // Arrange
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = album.Id,
            CurrentSizeBytes = 5000,
            CurrentPhotoCount = 10
        });

        var quota = await db.UserQuotas.FindAsync(owner.Id);
        quota!.UsedStorageBytes = 8000;
        quota.CurrentAlbumCount = 3;
        await db.SaveChangesAsync();

        // Act
        await service.CleanExpiredAlbums();

        // Assert
        var updatedQuota = await db.UserQuotas.FindAsync(owner.Id);
        Assert.Equal(3000, updatedQuota!.UsedStorageBytes);
        Assert.Equal(2, updatedQuota.CurrentAlbumCount);
    }

    [Fact]
    public async Task CleanExpiredAlbums_HandlesPartialStorageFailure()
    {
        // Arrange
        var storage = Substitute.For<IStorageService>();
        var (service, db, _) = CreateService(storage);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        var shard1 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 1024, storageKey: "key1");
        var shard2 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 1024, storageKey: "key2");
        await builder.CreateManifestAsync(album, [shard1, shard2]);

        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = album.Id,
            CurrentSizeBytes = 2048
        });

        var quota = await db.UserQuotas.FindAsync(owner.Id);
        quota!.UsedStorageBytes = 5000;
        quota.CurrentAlbumCount = 2;
        await db.SaveChangesAsync();

        // key1 succeeds, key2 fails
        storage.DeleteAsync("key1").Returns(Task.CompletedTask);
        storage.DeleteAsync("key2").ThrowsAsync(new IOException("disk error"));

        // Act
        var count = await service.CleanExpiredAlbums();

        // Assert — album deleted from DB despite storage failure
        Assert.Equal(1, count);
        Assert.Empty(db.Albums);

        // Quota still reclaimed
        var updatedQuota = await db.UserQuotas.FindAsync(owner.Id);
        Assert.Equal(2952, updatedQuota!.UsedStorageBytes);
        Assert.Equal(1, updatedQuota.CurrentAlbumCount);
    }

    [Fact]
    public async Task CleanExpiredAlbums_ClampsQuotaToZero_WhenAlbumSizeExceedsUsedStorage()
    {
        // Arrange — data inconsistency where album size > used storage
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();

        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = album.Id,
            CurrentSizeBytes = 5000,
            CurrentPhotoCount = 10
        });

        var quota = await db.UserQuotas.FindAsync(owner.Id);
        quota!.UsedStorageBytes = 1000; // Less than album's 5000
        quota.CurrentAlbumCount = 1;
        await db.SaveChangesAsync();

        // Act
        var count = await service.CleanExpiredAlbums();

        // Assert — quota clamped to 0, not negative
        Assert.Equal(1, count);
        var updatedQuota = await db.UserQuotas.FindAsync(owner.Id);
        Assert.Equal(0, updatedQuota!.UsedStorageBytes);
        Assert.Equal(0, updatedQuota.CurrentAlbumCount);
    }
}
