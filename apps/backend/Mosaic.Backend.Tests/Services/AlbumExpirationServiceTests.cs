using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class AlbumExpirationServiceTests
{
    [Fact]
    public async Task SweepExpiredManifests_UsesInjectedServerClockAndDetachesOpaqueShardContent()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(now);
        var service = new AlbumExpirationService(db, time, NullLogger<AlbumExpirationService>.Instance);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("photo-expiration-owner");
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 3);
        db.AlbumLimits.Add(new AlbumLimits { AlbumId = album.Id, CurrentPhotoCount = 1, CurrentSizeBytes = 2048 });
        await db.SaveChangesAsync();
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 2048);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
        manifest.ExpiresAt = now.AddMinutes(5);
        await db.SaveChangesAsync();

        var beforeDeadline = await service.SweepExpiredManifestsAsync();
        time.Advance(TimeSpan.FromMinutes(5));
        var atDeadline = await service.SweepExpiredManifestsAsync();

        Assert.Equal(0, beforeDeadline);
        Assert.Equal(1, atDeadline);
        var expiredManifest = db.Manifests.IgnoreQueryFilters().Single(m => m.Id == manifest.Id);
        Assert.True(expiredManifest.IsDeleted);
        Assert.Empty(expiredManifest.EncryptedMeta);
        Assert.Empty(db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id));
        Assert.Equal(ShardStatus.TRASHED, db.Shards.Single(s => s.Id == shard.Id).Status);
        Assert.Equal(4, db.Albums.Single(a => a.Id == album.Id).CurrentVersion);
        var limits = db.AlbumLimits.Single(al => al.AlbumId == album.Id);
        Assert.Equal(0, limits.CurrentPhotoCount);
        Assert.Equal(0, limits.CurrentSizeBytes);
    }

    [Fact]
    public async Task SweepExpiredAlbums_UsesInjectedServerClockAndRemovesAlbumRecords()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(now);
        var service = new AlbumExpirationService(db, time, NullLogger<AlbumExpirationService>.Instance);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("album-expiration-owner");
        var album = await builder.CreateAlbumAsync(owner);
        album.ExpiresAt = now.AddMinutes(10);
        await builder.CreateEpochKeyAsync(album, owner);
        db.AlbumContents.Add(new AlbumContent
        {
            AlbumId = album.Id,
            EncryptedContent = TestDataBuilder.GenerateRandomBytes(32),
            Nonce = TestDataBuilder.GenerateRandomBytes(24),
            EpochId = 1
        });
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 4096);
        var manifest = await builder.CreateManifestAsync(album, [shard]);
        await db.SaveChangesAsync();

        var beforeDeadline = await service.SweepExpiredAlbumsAsync();
        time.Advance(TimeSpan.FromMinutes(10));
        var atDeadline = await service.SweepExpiredAlbumsAsync();

        Assert.Equal(0, beforeDeadline);
        Assert.Equal(1, atDeadline);
        Assert.Null(await db.Albums.FindAsync(album.Id));
        Assert.Null(await db.Manifests.FindAsync(manifest.Id));
        Assert.Empty(db.AlbumMembers.Where(am => am.AlbumId == album.Id));
        Assert.Empty(db.EpochKeys.Where(ek => ek.AlbumId == album.Id));
        Assert.Empty(db.AlbumContents.Where(ac => ac.AlbumId == album.Id));
        Assert.Empty(db.ManifestShards);
        Assert.Equal(ShardStatus.TRASHED, db.Shards.Single(s => s.Id == shard.Id).Status);
    }
}
