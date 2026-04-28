using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ShardExpirationAccessTests
{
    private const string UploaderAuthSub = "expired-shard-uploader";

    private static ShardsController CreateController(
        Mosaic.Backend.Data.MosaicDbContext db,
        MockStorageService storage,
        TimeProvider timeProvider,
        string authSub = UploaderAuthSub)
        => new(db, storage, new MockCurrentUserService(db), timeProvider: timeProvider)
        {
            ControllerContext = { HttpContext = TestHttpContext.Create(authSub) }
        };

    [Fact]
    public async Task Download_ReturnsNotFound_WhenOnlyManifestReferenceIsExpired()
    {
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey);
        var manifest = await builder.CreateManifestAsync(album, [shard]);
        manifest.ExpiresAt = now;
        await db.SaveChangesAsync();

        var result = await CreateController(db, storage, new FakeTimeProvider(now)).Download(shard.Id);

        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task GetMeta_ReturnsNotFoundForUploader_WhenAlbumIsExpired()
    {
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        album.ExpiresAt = now;
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);
        await db.SaveChangesAsync();

        var result = await CreateController(db, storage, new FakeTimeProvider(now)).GetMeta(shard.Id);

        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Download_ReturnsForbidForNonMember_WhenOnlyManifestReferenceIsExpired()
    {
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        await builder.CreateUserAsync("expired-shard-outsider");
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        storage.AddFile(shard.StorageKey);
        var manifest = await builder.CreateManifestAsync(album, [shard]);
        manifest.ExpiresAt = now;
        await db.SaveChangesAsync();

        var result = await CreateController(db, storage, new FakeTimeProvider(now), "expired-shard-outsider").Download(shard.Id);

        Assert.IsType<ForbidResult>(result);
    }
}
