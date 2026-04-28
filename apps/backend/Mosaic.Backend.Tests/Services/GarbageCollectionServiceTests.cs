using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
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
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddSingleton<ILogger<AlbumExpirationService>>(NullLogger<AlbumExpirationService>.Instance);
        services.AddScoped<IAlbumExpirationService, AlbumExpirationService>();
        var provider = services.BuildServiceProvider();

        var config = CreateConfig();
        var logger = new NullLogger<GarbageCollectionService>();
        var service = new GarbageCollectionService(provider, logger);

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
    public async Task CleanExpiredAlbums_ReclaimsAlbumSlot_AndLeavesShardForTrashedCleanup()
    {
        var storage = new MockStorageService();
        var (service, db, _) = CreateService(storage);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 5000, storageKey: "expired-album-shard");
        storage.AddFile(shard.StorageKey);
        await builder.CreateManifestAsync(album, [shard]);
        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = album.Id,
            CurrentSizeBytes = 5000,
            CurrentPhotoCount = 1
        });
        await db.SaveChangesAsync();

        var quota = await db.UserQuotas.FindAsync(owner.Id);
        quota!.UsedStorageBytes = 8000;
        quota.CurrentAlbumCount = 3;
        await db.SaveChangesAsync();

        await service.CleanExpiredAlbums();

        var updatedQuota = await db.UserQuotas.FindAsync(owner.Id);
        Assert.Equal(8000, updatedQuota!.UsedStorageBytes);
        Assert.Equal(2, updatedQuota.CurrentAlbumCount);
        Assert.Empty(db.ManifestShards);
        Assert.Equal(ShardStatus.TRASHED, db.Shards.Single(s => s.Id == shard.Id).Status);

        var trashedShard = db.Shards.Single(s => s.Id == shard.Id);
        trashedShard.StatusUpdatedAt = DateTime.UtcNow.AddDays(-8);
        await db.SaveChangesAsync();

        var cleaned = await service.CleanTrashedShards();
        Assert.Equal(1, cleaned);

        updatedQuota = await db.UserQuotas.FindAsync(owner.Id);
        Assert.Equal(3000, updatedQuota!.UsedStorageBytes);
        Assert.Equal(2, updatedQuota.CurrentAlbumCount);
    }

    [Fact]
    public async Task CleanTrashedShards_ProcessesAllEligibleBatchesInOneRun()
    {
        var storage = new MockStorageService();
        var (service, db, _) = CreateService(storage);
        var builder = new TestDataBuilder(db);
        var uploader = await builder.CreateUserAsync("batch-uploader");
        var quota = await db.UserQuotas.FindAsync(uploader.Id);
        quota!.UsedStorageBytes = 250_000;

        var oldStatusTime = DateTime.UtcNow.AddDays(-8);
        var shards = Enumerable.Range(0, 250)
            .Select(i => new Shard
            {
                Id = Guid.NewGuid(),
                UploaderId = uploader.Id,
                StorageKey = $"trashed-{i}",
                SizeBytes = 1_000,
                Status = ShardStatus.TRASHED,
                StatusUpdatedAt = oldStatusTime
            })
            .ToList();

        foreach (var shard in shards)
        {
            storage.AddFile(shard.StorageKey);
        }

        db.Shards.AddRange(shards);
        await db.SaveChangesAsync();

        var cleaned = await service.CleanTrashedShards();

        Assert.Equal(250, cleaned);
        Assert.Empty(db.Shards);
        Assert.Equal(250, storage.DeletedKeys.Count);
        quota = await db.UserQuotas.FindAsync(uploader.Id);
        Assert.Equal(0, quota!.UsedStorageBytes);
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

        // Assert — storage is reclaimed when trashed shards are purged, but album slot is reclaimed now
        Assert.Equal(1, count);
        var updatedQuota = await db.UserQuotas.FindAsync(owner.Id);
        Assert.Equal(1000, updatedQuota!.UsedStorageBytes);
        Assert.Equal(0, updatedQuota.CurrentAlbumCount);
    }

    [Fact]
    public async Task CleanExpiredShareLinks_DeletesOnlyLinksPastRetentionWindow()
    {
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        var expiredLink = await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(-31));
        var recentExpiredLink = await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(-29));
        var activeLink = await builder.CreateShareLinkAsync(album, expiresAt: DateTimeOffset.UtcNow.AddDays(2));

        var count = await service.CleanExpiredShareLinks();

        Assert.Equal(1, count);
        Assert.Null(await db.ShareLinks.FindAsync(expiredLink.Id));
        Assert.NotNull(await db.ShareLinks.FindAsync(recentExpiredLink.Id));
        Assert.NotNull(await db.ShareLinks.FindAsync(activeLink.Id));
    }

    [Fact]
    public async Task CleanExpiredShareLinkGrants_KeepsRecentlyExpiredRowsWithinBuffer()
    {
        var (service, db, _) = CreateService();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync("owner");
        var album = await builder.CreateAlbumAsync(owner);
        var shareLink = await builder.CreateShareLinkAsync(album, maxUses: 5, useCount: 1);

        var oldGrant = new ShareLinkGrant
        {
            Id = Guid.NewGuid(),
            ShareLinkId = shareLink.Id,
            TokenHash = TestDataBuilder.GenerateRandomBytes(32),
            GrantedUseCount = 1,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-20),
            CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-25)
        };
        var bufferedGrant = new ShareLinkGrant
        {
            Id = Guid.NewGuid(),
            ShareLinkId = shareLink.Id,
            TokenHash = TestDataBuilder.GenerateRandomBytes(32),
            GrantedUseCount = 1,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-5),
            CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-8)
        };

        db.ShareLinkGrants.AddRange(oldGrant, bufferedGrant);
        await db.SaveChangesAsync();

        var count = await service.CleanExpiredShareLinkGrants();

        Assert.Equal(1, count);
        Assert.Null(await db.ShareLinkGrants.FindAsync(oldGrant.Id));
        Assert.NotNull(await db.ShareLinkGrants.FindAsync(bufferedGrant.Id));
    }
}
