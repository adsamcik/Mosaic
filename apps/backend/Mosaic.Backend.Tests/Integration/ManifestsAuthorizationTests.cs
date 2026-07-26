extern alias TestcontainersPostgreSql;

using System.Data.Common;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Tests.Helpers;
using Npgsql;
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

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task DeleteV2_LoadsManifestAfterAlbumLockAndRejectsStaleSignedTarget()
    {
        Guid albumId;
        Guid manifestId;
        Guid metadataReservationId;
        Guid tombstoneReservationId;
        long initialAlbumVersion;
        long initialManifestVersion;
        long initialMetadataVersion;
        string signerPubkey;
        byte[] updatedMetadata = TestDataBuilder.GenerateRandomBytes(32);

        await using (var seedDb = await _fixture.CreateFreshDbContextAsync())
        {
            var builder = new TestDataBuilder(seedDb);
            var owner = await builder.CreateUserAsync(OwnerAuthSub);
            var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
            var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
            var manifest = await builder.CreateManifestAsync(
                album,
                [shard],
                encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
            var signerBytes = TestDataBuilder.GenerateRandomBytes(32);
            signerPubkey = Convert.ToBase64String(signerBytes);
            await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);

            albumId = album.Id;
            manifestId = manifest.Id;
            initialAlbumVersion = album.CurrentVersion;
            initialManifestVersion = manifest.VersionCreated;
            initialMetadataVersion = manifest.MetadataVersion;
            metadataReservationId = Guid.CreateVersion7();
            tombstoneReservationId = Guid.CreateVersion7();
            seedDb.ManifestSequenceStates.Add(new ManifestSequenceState
            {
                AlbumId = albumId,
                SignerPubkey = signerPubkey,
                LastAllocatedSequence = 2,
                LastConsumedSequence = 0
            });
            seedDb.ManifestSequenceReservations.AddRange(
                new ManifestSequenceReservation
                {
                    Id = metadataReservationId,
                    AlbumId = albumId,
                    SignerPubkey = signerPubkey,
                    TargetManifestId = manifestId,
                    OperationId = Guid.CreateVersion7(),
                    OperationKind = ManifestSequenceOperations.MetadataUpdate,
                    ManifestSeq = 1,
                    CreatedAt = DateTime.UtcNow
                },
                new ManifestSequenceReservation
                {
                    Id = tombstoneReservationId,
                    AlbumId = albumId,
                    SignerPubkey = signerPubkey,
                    TargetManifestId = manifestId,
                    OperationId = Guid.CreateVersion7(),
                    OperationKind = ManifestSequenceOperations.Tombstone,
                    ManifestSeq = 2,
                    CreatedAt = DateTime.UtcNow
                });
            await seedDb.SaveChangesAsync();
        }

        await using var blockerConnection = new NpgsqlConnection(_fixture.ConnectionString);
        await blockerConnection.OpenAsync();
        await using var blockerTransaction = await blockerConnection.BeginTransactionAsync();
        await using (var blockerCommand = blockerConnection.CreateCommand())
        {
            blockerCommand.Transaction = blockerTransaction;
            blockerCommand.CommandText = "SELECT id FROM albums WHERE id = @albumId FOR UPDATE";
            blockerCommand.Parameters.AddWithValue("albumId", albumId);
            await blockerCommand.ExecuteScalarAsync();
        }

        var metadataLock = new LockAttemptInterceptor();
        var tombstoneLock = new LockAttemptInterceptor();
        await using var metadataDb = _fixture.CreateDbContext(metadataLock);
        await using var tombstoneDb = _fixture.CreateDbContext(tombstoneLock);
        var metadataController = CreateController(metadataDb, OwnerAuthSub);
        var tombstoneController = CreateController(tombstoneDb, OwnerAuthSub);

        var metadataTask = metadataController.UpdateMetadataV2(
            manifestId,
            new UpdateManifestMetadataRequest(
                Convert.ToBase64String(updatedMetadata),
                Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
                signerPubkey,
                1,
                metadataReservationId));
        await metadataLock.WaitUntilAttemptedAsync();
        metadataLock.AllowCommand();
        await Task.Delay(150);

        var tombstoneTask = tombstoneController.DeleteV2(
            manifestId,
            new DeleteManifestRequest(
                Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
                1,
                2,
                tombstoneReservationId,
                initialManifestVersion));
        await tombstoneLock.WaitUntilAttemptedAsync();
        tombstoneLock.AllowCommand();
        await Task.Delay(150);
        await blockerTransaction.CommitAsync();

        Assert.IsType<OkObjectResult>(await metadataTask.WaitAsync(TimeSpan.FromSeconds(10)));
        var staleDelete = Assert.IsType<ObjectResult>(
            await tombstoneTask.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.Equal(StatusCodes.Status409Conflict, staleDelete.StatusCode);
        Assert.Contains(
            "target manifest version",
            Assert.IsType<ProblemDetails>(staleDelete.Value).Detail,
            StringComparison.OrdinalIgnoreCase);

        await using var verifyDb = _fixture.CreateDbContext();
        var storedManifest = await verifyDb.Manifests
            .IgnoreQueryFilters()
            .SingleAsync(candidate => candidate.Id == manifestId);
        Assert.False(storedManifest.IsDeleted);
        Assert.Equal(updatedMetadata, storedManifest.EncryptedMeta);
        Assert.Equal(initialMetadataVersion + 1, storedManifest.MetadataVersion);
        Assert.Equal(initialAlbumVersion + 1, storedManifest.VersionCreated);
        Assert.Equal(initialAlbumVersion + 1,
            (await verifyDb.Albums.SingleAsync(candidate => candidate.Id == albumId)).CurrentVersion);
        Assert.NotNull((await verifyDb.ManifestSequenceReservations
            .SingleAsync(candidate => candidate.Id == metadataReservationId)).ConsumedAt);
        Assert.Null((await verifyDb.ManifestSequenceReservations
            .SingleAsync(candidate => candidate.Id == tombstoneReservationId)).ConsumedAt);
        Assert.Equal(1, (await verifyDb.ManifestSequenceStates
            .SingleAsync(candidate => candidate.AlbumId == albumId
                && candidate.SignerPubkey == signerPubkey)).LastConsumedSequence);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task SequenceReservations_ConcurrentRetriesAllocateOnce_AndMutationConsumesOnce()
    {
        const int uniqueOperationCount = 5;
        Guid albumId;
        Guid manifestId;
        long initialAlbumVersion;
        long initialMetadataVersion;
        string signerPubkey;

        await using (var seedDb = await _fixture.CreateFreshDbContextAsync())
        {
            var builder = new TestDataBuilder(seedDb);
            var owner = await builder.CreateUserAsync(OwnerAuthSub);
            var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
            var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
            var manifest = await builder.CreateManifestAsync(
                album,
                [shard],
                encryptedMeta: TestDataBuilder.GenerateRandomBytes(32));
            var signerBytes = TestDataBuilder.GenerateRandomBytes(32);
            signerPubkey = Convert.ToBase64String(signerBytes);
            await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);

            albumId = album.Id;
            manifestId = manifest.Id;
            initialAlbumVersion = album.CurrentVersion;
            initialMetadataVersion = manifest.MetadataVersion;
        }

        var sharedOperationId = Guid.CreateVersion7();
        var operationIds = new[]
        {
            sharedOperationId,
            sharedOperationId,
            sharedOperationId,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7()
        };
        var reserveStart = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var reserveTasks = operationIds.Select(async operationId =>
        {
            await reserveStart.Task;
            await using var db = _fixture.CreateDbContext();
            var controller = CreateController(db, OwnerAuthSub);
            var result = await controller.ReserveSequence(new ReserveManifestSequenceRequest(
                albumId,
                signerPubkey,
                manifestId,
                operationId,
                ManifestSequenceOperations.MetadataUpdate));
            return Assert.IsType<ManifestSequenceReservationResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
        }).ToArray();

        reserveStart.SetResult(true);
        var reservations = await Task.WhenAll(reserveTasks)
            .WaitAsync(TimeSpan.FromSeconds(15));

        var sharedReservations = reservations
            .Take(3)
            .ToArray();
        Assert.Single(sharedReservations.Select(result => result.ReservationId).Distinct());
        Assert.Single(sharedReservations.Select(result => result.ManifestSeq).Distinct());
        var distinctReservations = reservations
            .DistinctBy(result => result.ReservationId)
            .OrderBy(result => result.ManifestSeq)
            .ToArray();
        Assert.Equal(uniqueOperationCount, distinctReservations.Length);
        Assert.Equal(
            Enumerable.Range(1, uniqueOperationCount).Select(sequence => (long)sequence),
            distinctReservations.Select(result => result.ManifestSeq));

        var winningReservation = distinctReservations[^1];
        var updateRequest = new UpdateManifestMetadataRequest(
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(32)),
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            signerPubkey,
            winningReservation.ManifestSeq,
            winningReservation.ReservationId);
        var mutationStart = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var mutationTasks = Enumerable.Range(0, 2).Select(async _ =>
        {
            await mutationStart.Task;
            await using var db = _fixture.CreateDbContext();
            var controller = CreateController(db, OwnerAuthSub);
            return await controller.UpdateMetadataV2(manifestId, updateRequest);
        }).ToArray();

        mutationStart.SetResult(true);
        var mutationResults = await Task.WhenAll(mutationTasks)
            .WaitAsync(TimeSpan.FromSeconds(15));

        Assert.Single(mutationResults, result => result is OkObjectResult);
        var rejectedReplay = Assert.Single(mutationResults, result => result is ObjectResult);
        Assert.Equal(
            StatusCodes.Status409Conflict,
            Assert.IsType<ObjectResult>(rejectedReplay).StatusCode);

        await using var verifyDb = _fixture.CreateDbContext();
        Assert.Equal(
            uniqueOperationCount,
            await verifyDb.ManifestSequenceReservations.CountAsync());
        var sequenceState = await verifyDb.ManifestSequenceStates.SingleAsync(candidate =>
            candidate.AlbumId == albumId && candidate.SignerPubkey == signerPubkey);
        Assert.Equal(uniqueOperationCount, sequenceState.LastAllocatedSequence);
        Assert.Equal(winningReservation.ManifestSeq, sequenceState.LastConsumedSequence);
        Assert.Single(
            await verifyDb.ManifestSequenceReservations
                .Where(candidate => candidate.ConsumedAt.HasValue)
                .ToListAsync());
        var storedManifest = await verifyDb.Manifests.SingleAsync(candidate => candidate.Id == manifestId);
        Assert.Equal(initialMetadataVersion + 1, storedManifest.MetadataVersion);
        Assert.Equal(winningReservation.ManifestSeq, storedManifest.ManifestSeq);
        Assert.Equal(
            initialAlbumVersion + 1,
            (await verifyDb.Albums.SingleAsync(candidate => candidate.Id == albumId)).CurrentVersion);
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

    private sealed class LockAttemptInterceptor : DbCommandInterceptor
    {
        private readonly TaskCompletionSource<bool> _attempted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _allowed = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task WaitUntilAttemptedAsync()
            => await _attempted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        public void AllowCommand() => _allowed.TrySetResult(true);

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase))
            {
                _attempted.TrySetResult(true);
                await _allowed.Task.WaitAsync(cancellationToken);
            }

            return await base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
        }
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

        public MosaicDbContext CreateDbContext(params IInterceptor[] interceptors)
        {
            var options = new DbContextOptionsBuilder<MosaicDbContext>()
                .UseNpgsql(ConnectionString);
            if (interceptors.Length > 0)
            {
                options.AddInterceptors(interceptors);
            }

            return new MosaicDbContext(options.Options);
        }
    }
}
