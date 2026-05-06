using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ManifestExpirationControllerTests
{
    private const string OwnerAuthSub = "manifest-expiration-owner";
    private const string EditorAuthSub = "manifest-expiration-editor";
    private const string ViewerAuthSub = "manifest-expiration-viewer";

    private static ManifestsController CreateController(
        Mosaic.Backend.Data.MosaicDbContext db,
        IConfiguration config,
        string authSub,
        TimeProvider timeProvider)
        => new(
            db,
            TestConfiguration.CreateQuotaService(db, config),
            new MockCurrentUserService(db),
            NullLogger<ManifestsController>.Instance,
            timeProvider: timeProvider)
        {
            ControllerContext = { HttpContext = TestHttpContext.Create(authSub) }
        };

    [Fact]
    public async Task Create_DefaultsToNoExpiration_WhenExpiresAtOmitted()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING);

        var controller = CreateController(db, config, OwnerAuthSub, new FakeTimeProvider(now));
        var request = new CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: TestDataBuilder.GenerateRandomBytes(16),
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: [],
            TieredShards: [new TieredShardInfo(shard.Id.ToString(), (int)ShardTier.Original)]);

        var result = await controller.Create(request);

        var created = Assert.IsType<CreatedResult>(result);
        var manifestId = GetResponseProperty<Guid>(created.Value, "Id");
        Assert.Null(db.Manifests.Single(m => m.Id == manifestId).ExpiresAt);
    }

    [Fact]
    public async Task Create_StoresFutureExpirationUsingServerClock()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var expiresAt = now.AddHours(1);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING);

        var controller = CreateController(db, config, OwnerAuthSub, new FakeTimeProvider(now));
        var request = new CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: TestDataBuilder.GenerateRandomBytes(16),
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: [],
            TieredShards: [new TieredShardInfo(shard.Id.ToString(), (int)ShardTier.Original)],
            ExpiresAt: expiresAt);

        var result = await controller.Create(request);

        var created = Assert.IsType<CreatedResult>(result);
        var manifestId = GetResponseProperty<Guid>(created.Value, "Id");
        Assert.Equal(expiresAt, db.Manifests.Single(m => m.Id == manifestId).ExpiresAt);
    }

    [Fact]
    public async Task UpdateExpiration_AllowsEditorToSetAndRemovePhotoExpiration()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var editor = await builder.CreateUserAsync(EditorAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, editor, "editor", owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, EditorAuthSub, new FakeTimeProvider(now));
        var expiresAt = now.AddDays(2);

        var setResult = await controller.UpdateExpiration(manifest.Id, new UpdateManifestExpirationRequest(expiresAt));
        var clearResult = await controller.UpdateExpiration(manifest.Id, new UpdateManifestExpirationRequest(null));

        Assert.IsType<OkObjectResult>(setResult);
        Assert.IsType<OkObjectResult>(clearResult);
        await db.Entry(manifest).ReloadAsync();
        Assert.Null(manifest.ExpiresAt);
    }

    [Fact]
    public async Task UpdateExpiration_ReturnsForbid_WhenViewerAttemptsPhotoExpirationChange()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, ViewerAuthSub, new FakeTimeProvider(now));

        var result = await controller.UpdateExpiration(manifest.Id, new UpdateManifestExpirationRequest(now.AddDays(1)));

        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task UpdateExpiration_ReturnsNotFoundAndDoesNotExpire_WhenNonMemberTargetsExpiredPhoto()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync("manifest-expiration-outsider");
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
        manifest.ExpiresAt = now;
        await db.SaveChangesAsync();

        var controller = CreateController(db, config, "manifest-expiration-outsider", new FakeTimeProvider(now));

        var result = await controller.UpdateExpiration(manifest.Id, new UpdateManifestExpirationRequest(now.AddDays(1)));

        Assert.IsType<NotFoundResult>(result);
        var unchangedManifest = db.Manifests.IgnoreQueryFilters().Single(m => m.Id == manifest.Id);
        Assert.False(unchangedManifest.IsDeleted);
        Assert.NotEmpty(unchangedManifest.EncryptedMeta);
        Assert.NotEmpty(db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id));
    }

    [Fact]
    public async Task Get_ReturnsForbidAndDoesNotExpire_WhenNonMemberTargetsExpiredPhoto()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync("manifest-expiration-outsider");
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
        manifest.ExpiresAt = now;
        await db.SaveChangesAsync();

        var controller = CreateController(db, config, "manifest-expiration-outsider", new FakeTimeProvider(now));

        var result = await controller.Get(manifest.Id);

        Assert.IsType<ForbidResult>(result);
        var unchangedManifest = db.Manifests.IgnoreQueryFilters().Single(m => m.Id == manifest.Id);
        Assert.False(unchangedManifest.IsDeleted);
        Assert.NotEmpty(unchangedManifest.EncryptedMeta);
        Assert.NotEmpty(db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id));
    }

    [Fact]
    public async Task Get_ReturnsGoneAndRemovesOpaquePhotoContent_WhenServerClockReachesDeadline()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        db.AlbumLimits.Add(new AlbumLimits { AlbumId = album.Id, CurrentPhotoCount = 1, CurrentSizeBytes = 1024 });
        await db.SaveChangesAsync();
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 1024);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
        manifest.ExpiresAt = now;
        await db.SaveChangesAsync();

        var controller = CreateController(db, config, OwnerAuthSub, new FakeTimeProvider(now));

        var result = await controller.Get(manifest.Id);

        var gone = Assert.IsType<StatusCodeResult>(result);
        Assert.Equal(StatusCodes.Status410Gone, gone.StatusCode);
        var expiredManifest = db.Manifests.IgnoreQueryFilters().Single(m => m.Id == manifest.Id);
        Assert.True(expiredManifest.IsDeleted);
        Assert.Empty(expiredManifest.EncryptedMeta);
        Assert.Empty(db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id));
        Assert.Equal(ShardStatus.TRASHED, db.Shards.Single(s => s.Id == shard.Id).Status);
    }

    private static T GetResponseProperty<T>(object? response, string propertyName)
    {
        Assert.NotNull(response);
        var property = response.GetType().GetProperty(propertyName);
        Assert.NotNull(property);
        return Assert.IsType<T>(property.GetValue(response));
    }
}
