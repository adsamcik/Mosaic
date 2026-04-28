using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Albums;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class AlbumExpirationControllerTests
{
    private const string OwnerAuthSub = "album-expiration-owner";

    private static AlbumsController CreateController(Mosaic.Backend.Data.MosaicDbContext db, TimeProvider timeProvider)
        => new(
            db,
            new MockQuotaSettingsService(),
            new MockCurrentUserService(db),
            NullLogger<AlbumsController>.Instance,
            timeProvider: timeProvider);

    [Fact]
    public async Task Create_DefaultsToNoExpiration_WhenExpiresAtOmitted()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var controller = CreateController(db, new FakeTimeProvider(now));
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = TestHttpContext.Create(OwnerAuthSub)
        };

        var result = await controller.Create(new CreateAlbumRequest
        {
            InitialEpochKey = new InitialEpochKeyRequest
            {
                EncryptedKeyBundle = new byte[32],
                OwnerSignature = new byte[64],
                SharerPubkey = new byte[32],
                SignPubkey = new byte[32]
            }
        });

        Assert.IsType<CreatedResult>(result);
        Assert.Null(db.Albums.Single().ExpiresAt);
    }

    [Fact]
    public async Task Get_ReturnsGoneAndDeletesExpiredAlbum_WhenServerClockReachesDeadline()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = now;
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);
        await builder.CreateEpochKeyAsync(album, owner);
        await db.SaveChangesAsync();

        var controller = CreateController(db, new FakeTimeProvider(now));
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = TestHttpContext.Create(OwnerAuthSub)
        };

        var result = await controller.Get(album.Id);

        var gone = Assert.IsType<StatusCodeResult>(result);
        Assert.Equal(StatusCodes.Status410Gone, gone.StatusCode);
        Assert.Null(await db.Albums.FindAsync(album.Id));
        Assert.Null(await db.Manifests.FindAsync(manifest.Id));
        Assert.Empty(db.ManifestShards);
        Assert.Equal(ShardStatus.TRASHED, db.Shards.Single(s => s.Id == shard.Id).Status);
    }
}
