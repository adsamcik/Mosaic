using System.Collections.Concurrent;
using System.Data.Common;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class AlbumExpirationServiceTests
{
    [Fact]
    public async Task SweepExpiredManifests_IsNoOpAndPreservesSignedManifestState()
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
        Assert.Equal(0, atDeadline);
        var storedManifest = db.Manifests.IgnoreQueryFilters().Single(m => m.Id == manifest.Id);
        Assert.False(storedManifest.IsDeleted);
        Assert.NotEmpty(storedManifest.EncryptedMeta);
        Assert.NotEmpty(db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id));
        Assert.Equal(ShardStatus.ACTIVE, db.Shards.Single(s => s.Id == shard.Id).Status);
        Assert.Equal(3, db.Albums.Single(a => a.Id == album.Id).CurrentVersion);
        var limits = db.AlbumLimits.Single(al => al.AlbumId == album.Id);
        Assert.Equal(1, limits.CurrentPhotoCount);
        Assert.Equal(2048, limits.CurrentSizeBytes);
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

    [Fact]
    public async Task EnforceAlbumExpirationAsync_IsIdempotent_WhenConcurrentWorkersDeleteSameExpiredAlbum()
    {
        using var database = new SharedSqliteDatabase();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(now);

        Guid albumId;
        Guid manifestId;
        Guid shardId;
        string storageKey;
        byte[] opaquePayload = [0xde, 0xad, 0xbe, 0xef];

        await using (var seedDb = database.CreateContext())
        {
            var builder = new TestDataBuilder(seedDb);
            var owner = await builder.CreateUserAsync("concurrent-expired-album-owner");
            var album = await builder.CreateAlbumAsync(owner);
            album.ExpiresAt = now.AddMinutes(-1);
            await builder.CreateEpochKeyAsync(album, owner);
            seedDb.AlbumContents.Add(new AlbumContent
            {
                AlbumId = album.Id,
                EncryptedContent = TestDataBuilder.GenerateRandomBytes(32),
                Nonce = TestDataBuilder.GenerateRandomBytes(24),
                EpochId = 1
            });

            var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: opaquePayload.Length);
            var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
            await seedDb.SaveChangesAsync();

            albumId = album.Id;
            manifestId = manifest.Id;
            shardId = shard.Id;
            storageKey = shard.StorageKey;
        }

        var gate = new ConcurrentSaveChangesGate(participantCount: 2);
        await using var workerDb1 = database.CreateContext(gate);
        await using var workerDb2 = database.CreateContext(gate);
        var service1 = new AlbumExpirationService(workerDb1, time, NullLogger<AlbumExpirationService>.Instance);
        var service2 = new AlbumExpirationService(workerDb2, time, NullLogger<AlbumExpirationService>.Instance);

        var results = await Task.WhenAll(
            service1.EnforceAlbumExpirationAsync(albumId),
            service2.EnforceAlbumExpirationAsync(albumId));

        Assert.Equal(1, results.Count(deleted => deleted));

        await using var verifyDb = database.CreateContext();
        Assert.Null(await verifyDb.Albums.FindAsync(albumId));
        Assert.Null(await verifyDb.Manifests.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.Id == manifestId));
        Assert.Empty(await verifyDb.AlbumMembers.Where(am => am.AlbumId == albumId).ToListAsync());
        Assert.Empty(await verifyDb.EpochKeys.Where(ek => ek.AlbumId == albumId).ToListAsync());
        Assert.Empty(await verifyDb.AlbumContents.Where(ac => ac.AlbumId == albumId).ToListAsync());
        Assert.Empty(await verifyDb.ManifestShards.Where(ms => ms.ManifestId == manifestId).ToListAsync());
        Assert.Equal(ShardStatus.TRASHED, (await verifyDb.Shards.SingleAsync(s => s.Id == shardId)).Status);

        var repeatService = new AlbumExpirationService(verifyDb, time, NullLogger<AlbumExpirationService>.Instance);
        Assert.False(await repeatService.EnforceAlbumExpirationAsync(albumId));

        var storage = new MockStorageService();
        storage.AddFile(storageKey, opaquePayload);
        var controller = new ShardsController(verifyDb, storage, new MockCurrentUserService(verifyDb), timeProvider: time)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("concurrent-expired-album-owner")
            }
        };
        Assert.IsType<NotFoundResult>(await controller.Download(shardId));
    }

    [Fact]
    public async Task EnforceManifestExpirationAsync_DoesNotCreateUnsignedTombstone()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 28, 12, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(now);
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync("expired-manifest-owner");
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        db.AlbumLimits.Add(new AlbumLimits { AlbumId = album.Id, CurrentPhotoCount = 1, CurrentSizeBytes = 2048 });
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 2048);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
        manifest.ExpiresAt = now.AddMinutes(-1);
        await db.SaveChangesAsync();
        var service = new AlbumExpirationService(db, time, NullLogger<AlbumExpirationService>.Instance);

        var result = await service.EnforceManifestExpirationAsync(manifest.Id);

        Assert.False(result);
        var storedManifest = await db.Manifests.IgnoreQueryFilters().SingleAsync(m => m.Id == manifest.Id);
        Assert.False(storedManifest.IsDeleted);
        Assert.Equal(manifest.ExpiresAt, storedManifest.ExpiresAt);
        Assert.NotEmpty(storedManifest.EncryptedMeta);
        Assert.NotEmpty(await db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id).ToListAsync());
        Assert.Equal(ShardStatus.ACTIVE, (await db.Shards.SingleAsync(s => s.Id == shard.Id)).Status);
        Assert.Equal(7, (await db.Albums.SingleAsync(a => a.Id == album.Id)).CurrentVersion);
        var limits = await db.AlbumLimits.SingleAsync(al => al.AlbumId == album.Id);
        Assert.Equal(1, limits.CurrentPhotoCount);
        Assert.Equal(2048, limits.CurrentSizeBytes);
    }

    private sealed class SharedSqliteDatabase : IDisposable
    {
        private readonly string _connectionString = $"Data Source=expiration-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";
        private readonly SqliteConnection _rootConnection;

        public SharedSqliteDatabase()
        {
            _rootConnection = new SqliteConnection(_connectionString);
            _rootConnection.Open();

            using var db = CreateContext();
            db.Database.EnsureCreated();
        }

        public Mosaic.Backend.Data.MosaicDbContext CreateContext(params IInterceptor[] interceptors)
        {
            var options = new DbContextOptionsBuilder<Mosaic.Backend.Data.MosaicDbContext>()
                .UseSqlite(_connectionString)
                .AddInterceptors(interceptors)
                .Options;

            return new Mosaic.Backend.Data.MosaicDbContext(options);
        }

        public void Dispose()
        {
            _rootConnection.Dispose();
        }
    }

    private sealed class ConcurrentSaveChangesGate : DbCommandInterceptor
    {
        private readonly int _participantCount;
        private readonly ConcurrentDictionary<Guid, byte> _blockedContexts = new();
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _arrived;

        public ConcurrentSaveChangesGate(int participantCount)
        {
            _participantCount = participantCount;
        }

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            if (eventData.Context != null
                && _blockedContexts.TryAdd(eventData.Context.ContextId.InstanceId, 0))
            {
                if (Interlocked.Increment(ref _arrived) == _participantCount)
                {
                    _release.TrySetResult();
                }

                try
                {
                    await _release.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
                }
                catch (TimeoutException)
                {
                    _release.TrySetResult();
                    throw;
                }
            }

            return await base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
        }
    }
}
