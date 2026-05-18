extern alias TestcontainersPostgreSql;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Users;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using TestcontainersPostgreSql::Testcontainers.PostgreSql;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

/// <summary>
/// Real-Postgres tests for the GDPR Article 17 right-to-erasure flow
/// (v1.0.1 s15). Exercises both the <see cref="UserErasureService"/>
/// cascade and the <see cref="UsersController.DeleteMe"/> endpoint guards.
/// </summary>
public sealed class UserErasureIntegrationTests
    : IClassFixture<UserErasureIntegrationTests.PostgresFixture>
{
    private const string OwnerAuthSub = "erasure-owner";
    private const string CoOwnerAuthSub = "erasure-co-owner";

    private readonly PostgresFixture _fixture;

    public UserErasureIntegrationTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    // ─── Service-level tests ────────────────────────────────────────────

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task EraseAsync_RemovesAllOwnedAlbums_AndCascadesShards()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);
        var album = await data.CreateAlbumAsync(owner);
        var shard1 = await data.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var shard2 = await data.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await data.CreateManifestAsync(album, new() { shard1, shard2 });
        storage.AddFile(shard1.StorageKey);
        storage.AddFile(shard2.StorageKey);

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(owner.Id);

        Assert.Equal(1, result.OwnedAlbumsDeleted);
        Assert.Equal(2, result.ShardsDeleted);
        Assert.Equal(2, result.BlobsDeleted);
        Assert.Equal(0, result.BlobsFailed);
        Assert.Empty(await db.Users.Where(u => u.Id == owner.Id).ToListAsync());
        Assert.Empty(await db.Albums.Where(a => a.Id == album.Id).ToListAsync());
        Assert.Empty(await db.Shards.Where(s => s.Id == shard1.Id || s.Id == shard2.Id).ToListAsync());
        Assert.Empty(await db.Manifests.IgnoreQueryFilters().Where(m => m.AlbumId == album.Id).ToListAsync());
        Assert.Contains(shard1.StorageKey, storage.DeletedKeys);
        Assert.Contains(shard2.StorageKey, storage.DeletedKeys);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task EraseAsync_RemovesMembershipsButNotOtherOwnersAlbums()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);
        var member = await data.CreateUserAsync(CoOwnerAuthSub);
        var album = await data.CreateAlbumAsync(owner);
        await data.AddMemberAsync(album, member, "contributor", owner);

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(member.Id);

        Assert.Equal(0, result.OwnedAlbumsDeleted);
        Assert.True(result.MembershipsDeleted >= 1);

        // The other owner's album survives.
        Assert.NotNull(await db.Albums.FirstOrDefaultAsync(a => a.Id == album.Id));
        Assert.NotNull(await db.Users.FirstOrDefaultAsync(u => u.Id == owner.Id));

        // The departing member is gone, and their membership is gone.
        Assert.Empty(await db.Users.Where(u => u.Id == member.Id).ToListAsync());
        Assert.Empty(await db.AlbumMembers.Where(am => am.UserId == member.Id).ToListAsync());
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task EraseAsync_AnonymizesAuditLog_DoesNotDelete()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var user = await data.CreateUserAsync(OwnerAuthSub);
        db.AuditLogEntries.Add(new AuditLogEntry
        {
            Id = Guid.NewGuid(),
            EventType = "test.event",
            Outcome = "success",
            ActorUserId = user.Id,
            ActorWasErased = false
        });
        db.AuditLogEntries.Add(new AuditLogEntry
        {
            Id = Guid.NewGuid(),
            EventType = "test.event",
            Outcome = "success",
            ActorUserId = user.Id,
            ActorWasErased = false
        });
        await db.SaveChangesAsync();

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(user.Id);

        Assert.Equal(2, result.AuditEntriesAnonymised);
        // ExecuteUpdateAsync bypasses the change tracker, so query
        // against a fresh context to see the persisted state.
        await using var verify = await _fixture.GetContextAsync();
        var rows = await verify.AuditLogEntries.AsNoTracking()
            .Where(a => a.EventType == "test.event").ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.All(rows, r =>
        {
            Assert.Null(r.ActorUserId);
            Assert.True(r.ActorWasErased);
        });
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task EraseAsync_DeletesEncryptedBlobs()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var user = await data.CreateUserAsync(OwnerAuthSub);
        var album = await data.CreateAlbumAsync(user);
        var shard = await data.CreateShardAsync(user, ShardStatus.ACTIVE);
        await data.CreateManifestAsync(album, new() { shard });
        storage.AddFile(shard.StorageKey);

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(user.Id);

        Assert.Equal(1, result.BlobsDeleted);
        Assert.Equal(0, result.BlobsFailed);
        Assert.Contains(shard.StorageKey, storage.DeletedKeys);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task EraseAsync_DeletesAuthChallenges_KeyedByUsername()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var user = await data.CreateUserAsync(OwnerAuthSub);
        db.AuthChallenges.Add(new AuthChallenge
        {
            Id = Guid.NewGuid(),
            Username = OwnerAuthSub,
            Challenge = TestDataBuilder.GenerateRandomBytes(32),
            ExpiresAt = DateTime.UtcNow.AddMinutes(5)
        });
        await db.SaveChangesAsync();

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(user.Id);

        Assert.Equal(1, result.AuthChallengesDeleted);
        Assert.Empty(await db.AuthChallenges.Where(c => c.Username == OwnerAuthSub).ToListAsync());
    }

    // ─── Controller-level guard tests ───────────────────────────────────

    /// <summary>
    /// Regression for security-review-2026-05-18-01.
    /// Earlier code deleted ManifestShard rows by ShardId only, so when a
    /// shard was referenced by more than one manifest (e.g. dedup, or a
    /// co-owned album) erasing one user severed the unrelated manifest's
    /// reference too. The corrected algorithm must:
    ///   1. Drop the manifest-shard links for manifests in albums the
    ///      erased user owns.
    ///   2. Drop only shards that become orphaned (zero remaining links).
    /// Shards still referenced by manifests outside the erased user's
    /// owned albums MUST survive — both the Shard row AND its blob.
    /// </summary>
    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task DeleteMe_DoesNotCorruptOtherUsersAlbums_WhenSharedShardExists()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        // User A owns Album X (will be erased).
        var userA = await data.CreateUserAsync(OwnerAuthSub);
        var albumX = await data.CreateAlbumAsync(userA);

        // User B owns Album Z. Album Z references the SAME shard as
        // Album X — modelling cross-user dedup or a co-owned/forked
        // album path.
        var userB = await data.CreateUserAsync(CoOwnerAuthSub);
        var albumZ = await data.CreateAlbumAsync(userB);

        // The shared shard was uploaded by user B (so it is NOT in
        // userA's uploadedShards set). userA's manifest in Album X
        // references it via a ManifestShard link.
        var sharedShard = await data.CreateShardAsync(userB, ShardStatus.ACTIVE);
        storage.AddFile(sharedShard.StorageKey);

        var manifestX = await data.CreateManifestAsync(albumX, new() { sharedShard });
        var manifestZ = await data.CreateManifestAsync(albumZ, new() { sharedShard });

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(userA.Id);

        // Album X is gone; user A is gone.
        Assert.Empty(await db.Users.Where(u => u.Id == userA.Id).ToListAsync());
        Assert.Empty(await db.Albums.Where(a => a.Id == albumX.Id).ToListAsync());

        // User B and Album Z are untouched.
        Assert.NotNull(await db.Users.FirstOrDefaultAsync(u => u.Id == userB.Id));
        Assert.NotNull(await db.Albums.FirstOrDefaultAsync(a => a.Id == albumZ.Id));

        // The shared shard MUST still exist — it is still referenced by
        // manifestZ in Album Z. The shard row, its blob, and the
        // ManifestShard link in Z all survive.
        Assert.NotNull(await db.Shards.FirstOrDefaultAsync(s => s.Id == sharedShard.Id));
        Assert.DoesNotContain(sharedShard.StorageKey, storage.DeletedKeys);
        Assert.NotNull(await db.ManifestShards
            .FirstOrDefaultAsync(ms => ms.ManifestId == manifestZ.Id && ms.ShardId == sharedShard.Id));

        // No false-positive shard delete reported.
        Assert.Equal(0, result.ShardsDeleted);
        Assert.Equal(0, result.BlobsDeleted);
    }

    /// <summary>
    /// Companion to <see cref="DeleteMe_DoesNotCorruptOtherUsersAlbums_WhenSharedShardExists"/>:
    /// when an erased user has TWO of their OWN albums (X and Y) that
    /// both reference the same shard, the shard becomes a true orphan
    /// after erasure and MUST be reaped (row + blob).
    /// </summary>
    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task EraseAsync_ReapsShard_WhenOnlyReferencedByOwnedAlbums()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);
        var albumX = await data.CreateAlbumAsync(owner);
        var albumY = await data.CreateAlbumAsync(owner);
        var shard = await data.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await data.CreateManifestAsync(albumX, new() { shard });
        await data.CreateManifestAsync(albumY, new() { shard });
        storage.AddFile(shard.StorageKey);

        var sut = CreateService(db, storage);
        var result = await sut.EraseAsync(owner.Id);

        Assert.Equal(1, result.ShardsDeleted);
        Assert.Equal(1, result.BlobsDeleted);
        Assert.Empty(await db.Shards.Where(s => s.Id == shard.Id).ToListAsync());
        Assert.Contains(shard.StorageKey, storage.DeletedKeys);
    }

    // ─── Controller-level guard tests ───────────────────────────────────

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task DeleteMe_RequiresConfirmationText_RejectsWithoutMatch()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var user = await data.CreateUserAsync(OwnerAuthSub);

        var controller = CreateController(db);
        var result = await controller.DeleteMe(new DeleteMeRequest("wrong-username"));

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(400, problem.StatusCode);

        // User must still exist.
        Assert.NotNull(await db.Users.FirstOrDefaultAsync(u => u.Id == user.Id));
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task DeleteMe_HappyPath_ReturnsNoContent_AndErasesUser()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var user = await data.CreateUserAsync(OwnerAuthSub);

        var controller = CreateController(db);
        var result = await controller.DeleteMe(new DeleteMeRequest(OwnerAuthSub));

        Assert.IsType<NoContentResult>(result);
        Assert.Empty(await db.Users.Where(u => u.Id == user.Id).ToListAsync());
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task DeleteMe_AuditLogOmitsPlaintextUsername()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var user = await data.CreateUserAsync(OwnerAuthSub);

        var auditLog = new AuditLogService(
            db,
            TimeProvider.System,
            NullLogger<AuditLogService>.Instance);

        var controller = CreateController(db, auditLog);
        var result = await controller.DeleteMe(new DeleteMeRequest(OwnerAuthSub));
        Assert.IsType<NoContentResult>(result);

        // The success "user.erased" audit row MUST NOT carry the
        // plaintext AuthSub anywhere in its serialized details.
        // (security-review-2026-05-18-02)
        await using var verify = await _fixture.GetContextAsync();
        var rows = await verify.AuditLogEntries.AsNoTracking()
            .Where(a => a.EventType == AuditEventTypes.UserSelfErased
                     && a.Outcome == AuditOutcomes.Success)
            .ToListAsync();

        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            Assert.DoesNotContain(OwnerAuthSub, row.DetailsJson ?? string.Empty,
                StringComparison.Ordinal);
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    private static UserErasureService CreateService(MosaicDbContext db, MockStorageService storage)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Path"] = Path.Combine(Path.GetTempPath(), "mosaic-erasure-tests")
            })
            .Build();
        return new UserErasureService(db, storage, config, NullLogger<UserErasureService>.Instance);
    }

    private UsersController CreateController(MosaicDbContext db, IAuditLogService? auditLog = null)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                // Default to ProxyAuth so fresh-auth signature is not required.
                ["Auth:LocalAuthEnabled"] = "false",
                ["Storage:Path"] = Path.Combine(Path.GetTempPath(), "mosaic-erasure-tests")
            })
            .Build();
        var erasure = new UserErasureService(db, new MockStorageService(), config, NullLogger<UserErasureService>.Instance);
        var controller = new UsersController(
            db,
            config,
            new MockCurrentUserService(db),
            NullLogger<UsersController>.Instance,
            new TestWebHostEnvironment(),
            erasure,
            rustHost: null,
            auditLog: auditLog)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };
        return controller;
    }

    private sealed class TestWebHostEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "Mosaic.Backend.Tests";
        public string WebRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider WebRootFileProvider { get; set; }
            = new Microsoft.Extensions.FileProviders.NullFileProvider();
        public string ContentRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; }
            = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }

    public sealed class PostgresFixture : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();

        public string ConnectionString => _container.GetConnectionString();

        public async Task InitializeAsync()
        {
            await _container.StartAsync();
            await using var db = CreateDbContext();
            await db.Database.EnsureCreatedAsync();
        }

        public async Task DisposeAsync()
        {
            await _container.DisposeAsync();
        }

        public async Task<MosaicDbContext> CreateFreshDbContextAsync()
        {
            var db = CreateDbContext();
            await db.Database.ExecuteSqlRawAsync(
                "TRUNCATE TABLE audit_log_entries, auth_challenges, users " +
                "RESTART IDENTITY CASCADE");
            return db;
        }

        /// <summary>
        /// Returns a fresh, untracked context for verification queries
        /// (used to read persisted state after <c>ExecuteUpdateAsync</c>
        /// has bypassed the change tracker of the writer context).
        /// </summary>
        public Task<MosaicDbContext> GetContextAsync() => Task.FromResult(CreateDbContext());

        private MosaicDbContext CreateDbContext()
            => new(new DbContextOptionsBuilder<MosaicDbContext>()
                .UseNpgsql(ConnectionString)
                .Options);
    }
}

