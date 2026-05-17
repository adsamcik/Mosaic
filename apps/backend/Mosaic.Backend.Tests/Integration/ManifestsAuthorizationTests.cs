extern alias TestcontainersPostgreSql;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Tests.Helpers;
using TestcontainersPostgreSql::Testcontainers.PostgreSql;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

/// <summary>
/// Real-Postgres authorization tests for <see cref="ManifestsController.Create"/>.
///
/// These tests previously lived in <c>SecurityTests.cs</c> marked
/// <c>[Fact(Skip = "Requires PostgreSQL - uses FOR UPDATE row locking")]</c> with a
/// comment claiming they were covered elsewhere. That claim was false — there was
/// no other coverage of the NonMember / Viewer / RevokedMember Forbid paths on
/// <c>ManifestsController.Create</c>. v1.0.1 s26 moves them here so they actually
/// run against the same Testcontainers Postgres harness used by other Integration
/// tests, exercising the real <c>SELECT ... FOR UPDATE</c> code path.
/// </summary>
public sealed class ManifestsAuthorizationTests
    : IClassFixture<ManifestsAuthorizationTests.PostgresFixture>
{
    private const string OwnerAuthSub = "manifests-authz-owner";
    private const string OtherAuthSub = "manifests-authz-other";

    private readonly PostgresFixture _fixture;

    public ManifestsAuthorizationTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Create_RejectsNonMember_WithForbid()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);

        var controller = CreateController(db, OtherAuthSub);
        var request = BuildValidRequest(album.Id);

        var result = await controller.Create(request);

        Assert.IsType<ForbidResult>(result);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Create_RejectsViewerRole_WithForbid()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);

        var controller = CreateController(db, OtherAuthSub);
        var request = BuildValidRequest(album.Id);

        var result = await controller.Create(request);

        // Viewers cannot create manifests (only contributors and owners).
        Assert.IsType<ForbidResult>(result);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Create_RejectsRevokedMember_WithForbid()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(OtherAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, member, "contributor", owner);

        // Revoke membership: the active-membership filter
        // (RevokedAt == null) must reject the request.
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var controller = CreateController(db, OtherAuthSub);
        var request = BuildValidRequest(album.Id);

        var result = await controller.Create(request);

        Assert.IsType<ForbidResult>(result);
    }

    private static ManifestsController CreateController(MosaicDbContext db, string authSub)
    {
        return new ManifestsController(
            db,
            new MockQuotaSettingsService(),
            new MockCurrentUserService(db),
            NullLoggerFactory.CreateNullLogger<ManifestsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(authSub)
            }
        };
    }

    /// <summary>
    /// Builds a payload that passes <c>ValidateFinalizeRequest</c> so the request
    /// reaches the authorization check. The shard id need not exist in the DB —
    /// authz rejects before any shard lookup.
    /// </summary>
    private static CreateManifestRequest BuildValidRequest(Guid albumId)
    {
        return new CreateManifestRequest(
            AlbumId: albumId,
            EncryptedMeta: new byte[100],
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: new List<string>(),
            TieredShards: new List<TieredShardInfo>
            {
                new(
                    ShardId: Guid.NewGuid().ToString(),
                    Tier: 3,
                    ShardIndex: 0,
                    Sha256: new string('0', 64),
                    ContentLength: 1024,
                    EnvelopeVersion: 3)
            });
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

        /// <summary>
        /// Returns a fresh <see cref="MosaicDbContext"/> bound to a clean database state.
        /// Truncates every table touched by these tests so each test runs in isolation.
        /// </summary>
        public async Task<MosaicDbContext> CreateFreshDbContextAsync()
        {
            var db = CreateDbContext();
            await db.Database.ExecuteSqlRawAsync(
                "TRUNCATE TABLE manifest_shards, manifests, epoch_keys, album_members, albums, " +
                "shards, user_quotas, users RESTART IDENTITY CASCADE");
            return db;
        }

        private MosaicDbContext CreateDbContext()
            => new(new DbContextOptionsBuilder<MosaicDbContext>()
                .UseNpgsql(ConnectionString)
                .Options);
    }
}
