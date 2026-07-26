using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ManifestProtocolContractTests
{
    private const string OwnerAuthSub = "manifest-protocol-owner";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    [Fact]
    public async Task Sync_ReturnsAlbumSyncFetcherContractShape()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 41);
        var thumb = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 11);
        var preview = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 22);
        var original = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 33);
        var manifest = await builder.CreateManifestAsync(album, [preview, original, thumb], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        manifest.VersionCreated = 42;
        album.CurrentVersion = 42;
        foreach (var link in db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id))
        {
            var shard = db.Shards.Single(s => s.Id == link.ShardId);
            link.Sha256 = shard.Sha256!;
            link.ContentLength = shard.SizeBytes;
            link.Tier = shard.Id == thumb.Id
                ? (int)ShardTier.Thumb
                : shard.Id == preview.Id
                    ? (int)ShardTier.Preview
                    : (int)ShardTier.Original;
        }
        await db.SaveChangesAsync();

        var controller = CreateAlbumsController(db);

        var result = await controller.Sync(album.Id, since: 41);

        var ok = Assert.IsType<OkObjectResult>(result);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value, JsonOptions));
        var syncShape = new
        {
            albumId = document.RootElement.GetProperty("albumId"),
            currentVersion = document.RootElement.GetProperty("currentVersion"),
            manifestId = document.RootElement.GetProperty("manifestId"),
            manifestUrl = document.RootElement.GetProperty("manifestUrl"),
            expectedSha256 = document.RootElement.GetProperty("expectedSha256"),
            manifests = document.RootElement.GetProperty("manifests"),
            currentEpochId = document.RootElement.GetProperty("currentEpochId"),
            albumVersion = document.RootElement.GetProperty("albumVersion"),
            hasMore = document.RootElement.GetProperty("hasMore")
        };
        Assert.Equal(album.Id, syncShape.albumId.GetGuid());
        Assert.Equal(42, syncShape.currentVersion.GetInt64());
        Assert.Equal(manifest.Id, syncShape.manifestId.GetGuid());
        Assert.Equal($"/api/v1/manifests/{manifest.Id}", syncShape.manifestUrl.GetString());
        Assert.Equal(thumb.Sha256, syncShape.expectedSha256.GetString());
        AssertContract("album-sync.contract.json", ToShapeJson(syncShape));
    }

    [Fact]
    public async Task Finalize_ReturnsAdr022ResponseContractShape()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var thumb = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var preview = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 22);
        var original = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 33);
        var manifestId = Guid.CreateVersion7();
        var request = new CreateManifestRequest(
            ProtocolVersion: 1,
            AlbumId: album.Id,
            AssetType: "Image",
            EncryptedMeta: TestDataBuilder.GenerateRandomBytes(32),
            EncryptedMetaSidecar: TestDataBuilder.GenerateRandomBytes(24),
            Signature: Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            SignerPubkey: Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(32)),
            ShardIds: [],
            TieredShards:
            [
                ToTieredShard(thumb, ShardTier.Thumb),
                ToTieredShard(preview, ShardTier.Preview),
                ToTieredShard(original, ShardTier.Original)
            ]);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: Convert.FromBase64String(request.SignerPubkey));

        var controller = CreateManifestsController(db);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);

        var result = await controller.Finalize(manifestId, request);

        var created = Assert.IsType<CreatedResult>(result);
        var response = Assert.IsType<ManifestFinalizeResponse>(created.Value);
        Assert.Equal(1, response.ProtocolVersion);
        Assert.Equal(manifestId, response.ManifestId);
        Assert.Equal(1, response.MetadataVersion);
        Assert.Equal(3, response.TieredShards.Count);
        AssertContract("manifest-finalize.contract.json", ToShapeJson(response));
    }

    [Fact]
    public async Task Finalize_PersistsCanonicalSignerPubkeySpelling()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var signerBytes = TestDataBuilder.GenerateRandomBytes(32);
        var canonicalSigner = Convert.ToBase64String(signerBytes);
        var nonCanonicalSigner = canonicalSigner.Insert(8, " \r\n");
        var manifestId = Guid.CreateVersion7();
        var request = CreateFinalizeRequest(album.Id, shard) with
        {
            SignerPubkey = nonCanonicalSigner
        };
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);
        var controller = CreateManifestsController(db);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);

        var result = await controller.Finalize(manifestId, request);

        Assert.IsType<CreatedResult>(result);
        var stored = await db.Manifests.SingleAsync(m => m.Id == manifestId);
        var reservation = await db.ManifestSequenceReservations
            .SingleAsync(r => r.Id == request.SequenceReservationId);
        Assert.Equal(canonicalSigner, stored.SignerPubkey);
        Assert.Equal(canonicalSigner, reservation.SignerPubkey);
        Assert.DoesNotContain(' ', stored.SignerPubkey);
        Assert.DoesNotContain('\r', stored.SignerPubkey);
        Assert.DoesNotContain('\n', stored.SignerPubkey);
    }

    [Fact]
    public async Task Finalize_ExactRetry_ReturnsOriginalCreatedResponseWithoutSecondMutation()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 19);
        var manifestId = Guid.CreateVersion7();
        var request = CreateFinalizeRequest(album.Id, shard);
        await builder.CreateEpochKeyAsync(
            album,
            owner,
            signPubkey: Convert.FromBase64String(request.SignerPubkey));
        var controller = CreateManifestsController(db);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);

        var firstResult = await controller.Finalize(manifestId, request);
        var firstCreated = Assert.IsType<CreatedResult>(firstResult);
        var firstResponse = Assert.IsType<ManifestFinalizeResponse>(firstCreated.Value);
        var versionAfterFirst = album.CurrentVersion;

        var replayResult = await controller.Finalize(manifestId, request);

        var replayCreated = Assert.IsType<CreatedResult>(replayResult);
        var replayResponse = Assert.IsType<ManifestFinalizeResponse>(replayCreated.Value);
        Assert.Equal(firstCreated.Location, replayCreated.Location);
        Assert.Equal(firstResponse.ManifestId, replayResponse.ManifestId);
        Assert.Equal(firstResponse.CreatedAt, replayResponse.CreatedAt);
        Assert.Equal(firstResponse.TieredShards, replayResponse.TieredShards);
        Assert.Equal("true", controller.Response.Headers["Idempotency-Replayed"].ToString());
        Assert.Equal(versionAfterFirst, album.CurrentVersion);
        Assert.Single(await db.Manifests.ToListAsync());
        Assert.Equal(32, (await db.Manifests.SingleAsync()).FinalizeRequestHash?.Length);
        Assert.Equal(1, (await db.AlbumLimits.FindAsync(album.Id))!.CurrentPhotoCount);
    }

    [Fact]
    public async Task Finalize_ExactRetryAfterMetadataMutation_ReplaysOriginalCreatedResponse()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 19);
        var manifestId = Guid.CreateVersion7();
        var request = CreateFinalizeRequest(album.Id, shard);
        await builder.CreateEpochKeyAsync(
            album,
            owner,
            signPubkey: Convert.FromBase64String(request.SignerPubkey));
        var controller = CreateManifestsController(db);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);

        var firstCreated = Assert.IsType<CreatedResult>(await controller.Finalize(manifestId, request));
        var firstResponse = Assert.IsType<ManifestFinalizeResponse>(firstCreated.Value);
        var firstEtag = controller.Response.Headers.ETag.ToString();
        var metadataReservation = await ReserveSequenceAsync(
            controller,
            album.Id,
            request.SignerPubkey,
            manifestId,
            ManifestSequenceOperations.MetadataUpdate);
        var metadataResult = await controller.UpdateMetadataV2(
            manifestId,
            new UpdateManifestMetadataRequest(
                Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(20)),
                Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
                request.SignerPubkey,
                metadataReservation.ManifestSeq,
                metadataReservation.ReservationId));
        Assert.IsType<OkObjectResult>(metadataResult);
        var versionAfterMetadata = album.CurrentVersion;
        Assert.Equal(2, (await db.Manifests.SingleAsync()).MetadataVersion);

        var replayCreated = Assert.IsType<CreatedResult>(await controller.Finalize(manifestId, request));
        var replayResponse = Assert.IsType<ManifestFinalizeResponse>(replayCreated.Value);

        Assert.Equal(firstCreated.Location, replayCreated.Location);
        Assert.Equal(firstResponse.ProtocolVersion, replayResponse.ProtocolVersion);
        Assert.Equal(firstResponse.ManifestId, replayResponse.ManifestId);
        Assert.Equal(firstResponse.MetadataVersion, replayResponse.MetadataVersion);
        Assert.Equal(firstResponse.CreatedAt, replayResponse.CreatedAt);
        Assert.Equal(firstResponse.TieredShards, replayResponse.TieredShards);
        Assert.Equal(firstEtag, controller.Response.Headers.ETag.ToString());
        Assert.Equal("true", controller.Response.Headers["Idempotency-Replayed"].ToString());
        Assert.Equal(versionAfterMetadata, album.CurrentVersion);
        var stored = await db.Manifests.SingleAsync();
        Assert.Equal(2, stored.MetadataVersion);
        Assert.Equal(1, stored.FinalizeMetadataVersion);
        Assert.Equal(metadataReservation.ManifestSeq, stored.ManifestSeq);
    }

    [Fact]
    public async Task Finalize_SameManifestIdWithDifferentRequest_RemainsConflict()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 19);
        var manifestId = Guid.CreateVersion7();
        var request = CreateFinalizeRequest(album.Id, shard);
        await builder.CreateEpochKeyAsync(
            album,
            owner,
            signPubkey: Convert.FromBase64String(request.SignerPubkey));
        var controller = CreateManifestsController(db);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);
        Assert.IsType<CreatedResult>(await controller.Finalize(manifestId, request));
        var versionAfterFirst = album.CurrentVersion;

        var mismatchedRequest = request with
        {
            EncryptedMeta = TestDataBuilder.GenerateRandomBytes(request.EncryptedMeta.Length)
        };
        var conflictResult = await controller.Finalize(manifestId, mismatchedRequest);

        var conflict = Assert.IsType<ConflictObjectResult>(conflictResult);
        Assert.Equal(StatusCodes.Status409Conflict, conflict.StatusCode);
        Assert.Equal(versionAfterFirst, album.CurrentVersion);
        Assert.Single(await db.Manifests.ToListAsync());
        Assert.Equal(1, (await db.AlbumLimits.FindAsync(album.Id))!.CurrentPhotoCount);
    }

    [Fact]
    public async Task Finalize_CommitsMonotonicAlbumManifestVersions()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var controller = CreateManifestsController(db);

        var firstShard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var firstRequest = CreateFinalizeRequest(album.Id, firstShard);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: Convert.FromBase64String(firstRequest.SignerPubkey));
        var firstManifestId = Guid.CreateVersion7();
        firstRequest = await ReserveCreateSequenceAsync(controller, album.Id, firstManifestId, firstRequest);
        var first = await controller.Finalize(firstManifestId, firstRequest);
        Assert.IsType<CreatedResult>(first);

        var secondShard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 12);
        var secondRequest = CreateFinalizeRequest(album.Id, secondShard) with
        {
            SignerPubkey = firstRequest.SignerPubkey
        };
        var secondManifestId = Guid.CreateVersion7();
        secondRequest = await ReserveCreateSequenceAsync(controller, album.Id, secondManifestId, secondRequest);
        var second = await controller.Finalize(secondManifestId, secondRequest);
        Assert.IsType<CreatedResult>(second);

        var versions = db.Manifests.OrderBy(m => m.VersionCreated).Select(m => m.VersionCreated).ToArray();
        Assert.Equal([8, 9], versions);
        Assert.Equal(9, db.Albums.Single(a => a.Id == album.Id).CurrentVersion);
    }

    [Fact]
    public async Task Finalize_QuarantinesCommittedUpload_WhenBackingBlobIsMissing()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 32);
        db.TusUploadLifecycles.Add(new TusUploadLifecycle
        {
            FileId = shard.Id.ToString(),
            UserId = owner.Id,
            ReservedBytes = shard.SizeBytes,
            UploadLength = shard.SizeBytes,
            State = TusUploadLifecycleState.COMMITTED,
            CommittedAt = DateTime.UtcNow
        });
        await db.SaveChangesAsync();

        var manifestId = Guid.CreateVersion7();
        var request = CreateFinalizeRequest(album.Id, shard);
        await builder.CreateEpochKeyAsync(
            album,
            owner,
            signPubkey: Convert.FromBase64String(request.SignerPubkey));
        var storage = new MockStorageService();
        var controller = CreateManifestsController(db, storage);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);

        var result = await controller.Finalize(manifestId, request);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);
        db.ChangeTracker.Clear();
        Assert.Empty(await db.Manifests.ToListAsync());
        Assert.Equal(ShardStatus.PENDING, (await db.Shards.FindAsync(shard.Id))!.Status);
        Assert.Equal(7, (await db.Albums.FindAsync(album.Id))!.CurrentVersion);
        var lifecycle = await db.TusUploadLifecycles.FindAsync(shard.Id.ToString());
        Assert.Equal(TusUploadLifecycleState.QUARANTINED, lifecycle!.State);
        Assert.Equal("manifest-finalization-blob-unreadable", lifecycle.QuarantineReason);
        var reservation = await db.ManifestSequenceReservations.FindAsync(request.SequenceReservationId!.Value);
        Assert.Null(reservation!.ConsumedAt);
        var sequenceState = await db.ManifestSequenceStates.FindAsync(
            album.Id,
            request.SignerPubkey);
        Assert.Equal(0, sequenceState!.LastConsumedSequence);
    }

    [Fact]
    public void LegacyMutationAdapters_AreNotRoutableMvcActions()
    {
        var controllerType = typeof(ManifestsController);
        Assert.NotEmpty(controllerType.GetMethod(nameof(ManifestsController.Create))!
            .GetCustomAttributes(typeof(NonActionAttribute), inherit: true));
        Assert.NotEmpty(controllerType.GetMethod(nameof(ManifestsController.UpdateMetadata))!
            .GetCustomAttributes(typeof(NonActionAttribute), inherit: true));
        Assert.NotEmpty(controllerType.GetMethod(nameof(ManifestsController.Delete))!
            .GetCustomAttributes(typeof(NonActionAttribute), inherit: true));
    }

    [Fact]
    public async Task SequenceReservation_IsIdempotentAndMonotonicPerSigner()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var signerBytes = TestDataBuilder.GenerateRandomBytes(32);
        var signerPubkey = Convert.ToBase64String(signerBytes);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);
        var controller = CreateManifestsController(db);
        var operationId = Guid.CreateVersion7();
        var firstTarget = Guid.CreateVersion7();

        var first = await ReserveSequenceAsync(
            controller, album.Id, signerPubkey, firstTarget, ManifestSequenceOperations.Create, operationId);
        var retry = await ReserveSequenceAsync(
            controller, album.Id, signerPubkey, firstTarget, ManifestSequenceOperations.Create, operationId);
        var next = await ReserveSequenceAsync(
            controller, album.Id, signerPubkey, Guid.CreateVersion7(), ManifestSequenceOperations.Create);

        Assert.Equal(first.ReservationId, retry.ReservationId);
        Assert.Equal(first.ManifestSeq, retry.ManifestSeq);
        Assert.Equal(first.ManifestSeq + 1, next.ManifestSeq);
        Assert.Equal(2, await db.ManifestSequenceReservations.CountAsync());
    }

    [Fact]
    public async Task Finalize_RejectsOlderOutstandingReservationAfterNewerSequenceCommits()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var olderShard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var newerShard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 12);
        var olderManifestId = Guid.CreateVersion7();
        var newerManifestId = Guid.CreateVersion7();
        var olderRequest = CreateFinalizeRequest(album.Id, olderShard);
        var signerBytes = Convert.FromBase64String(olderRequest.SignerPubkey);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);
        var newerRequest = CreateFinalizeRequest(album.Id, newerShard) with
        {
            SignerPubkey = olderRequest.SignerPubkey
        };
        var controller = CreateManifestsController(db);
        olderRequest = await ReserveCreateSequenceAsync(
            controller,
            album.Id,
            olderManifestId,
            olderRequest);
        newerRequest = await ReserveCreateSequenceAsync(
            controller,
            album.Id,
            newerManifestId,
            newerRequest);

        Assert.True(newerRequest.ManifestSeq > olderRequest.ManifestSeq);
        Assert.IsType<CreatedResult>(await controller.Finalize(newerManifestId, newerRequest));
        var staleResult = await controller.Finalize(olderManifestId, olderRequest);

        var conflict = Assert.IsType<ObjectResult>(staleResult);
        Assert.Equal(StatusCodes.Status409Conflict, conflict.StatusCode);
        var problem = Assert.IsType<ProblemDetails>(conflict.Value);
        var detail = problem.Detail;
        Assert.Equal("MANIFEST_SEQUENCE_STALE", problem.Extensions["code"]);
        Assert.Contains("retry the sequence reservation", detail, StringComparison.Ordinal);
        Assert.Contains("re-sign", detail, StringComparison.Ordinal);
        Assert.Single(await db.Manifests.ToListAsync());
        Assert.Equal(newerManifestId, (await db.Manifests.SingleAsync()).Id);
        var staleReservation = await db.ManifestSequenceReservations
            .SingleAsync(r => r.Id == olderRequest.SequenceReservationId);
        Assert.False(staleReservation.ConsumedAt.HasValue);
        Assert.True((await db.ManifestSequenceReservations
            .SingleAsync(r => r.Id == newerRequest.SequenceReservationId)).ConsumedAt.HasValue);

        var reissued = await ReserveSequenceAsync(
            controller,
            album.Id,
            olderRequest.SignerPubkey,
            olderManifestId,
            ManifestSequenceOperations.Create,
            staleReservation.OperationId);
        Assert.Equal(staleReservation.Id, reissued.ReservationId);
        Assert.Equal(newerRequest.ManifestSeq + 1, reissued.ManifestSeq);
        olderRequest = olderRequest with
        {
            ManifestSeq = reissued.ManifestSeq,
            SequenceReservationId = reissued.ReservationId,
            Signature = Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64))
        };

        Assert.IsType<CreatedResult>(await controller.Finalize(olderManifestId, olderRequest));
        Assert.Equal(2, await db.Manifests.CountAsync());
        Assert.True((await db.ManifestSequenceReservations
            .SingleAsync(r => r.Id == reissued.ReservationId)).ConsumedAt.HasValue);
        var state = await db.ManifestSequenceStates.FindAsync(
            album.Id,
            Convert.ToBase64String(signerBytes));
        Assert.Equal(reissued.ManifestSeq, state!.LastConsumedSequence);
        Assert.Equal(2, (await db.AlbumLimits.FindAsync(album.Id))!.CurrentPhotoCount);
    }

    [Fact]
    public async Task MetadataV2_ConsumesReservationAndPersistsSignedSequence()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        var signerBytes = TestDataBuilder.GenerateRandomBytes(32);
        var signerPubkey = Convert.ToBase64String(signerBytes);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);
        var controller = CreateManifestsController(db);
        var reservation = await ReserveSequenceAsync(
            controller, album.Id, signerPubkey, manifest.Id, ManifestSequenceOperations.MetadataUpdate);

        var result = await controller.UpdateMetadataV2(manifest.Id, new UpdateManifestMetadataRequest(
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(20)),
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            signerPubkey,
            reservation.ManifestSeq,
            reservation.ReservationId));

        Assert.IsType<OkObjectResult>(result);
        var stored = await db.Manifests.SingleAsync(candidate => candidate.Id == manifest.Id);
        Assert.Equal(reservation.ManifestSeq, stored.ManifestSeq);
        Assert.NotNull((await db.ManifestSequenceReservations.FindAsync(reservation.ReservationId))!.ConsumedAt);
    }

    [Fact]
    public async Task DeleteV2_AdvancesSyncCursorAndPreservesSignedTargetVersion()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        var signedTargetVersion = manifest.VersionCreated;
        var signerBytes = TestDataBuilder.GenerateRandomBytes(32);
        var signerPubkey = Convert.ToBase64String(signerBytes);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerBytes);
        var controller = CreateManifestsController(db);
        var reservation = await ReserveSequenceAsync(
            controller, album.Id, signerPubkey, manifest.Id, ManifestSequenceOperations.Tombstone);

        var result = await controller.DeleteV2(manifest.Id, new DeleteManifestRequest(
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            album.CurrentEpochId,
            reservation.ManifestSeq,
            reservation.ReservationId,
            signedTargetVersion));

        Assert.IsType<NoContentResult>(result);
        var stored = await db.Manifests.IgnoreQueryFilters().SingleAsync(candidate => candidate.Id == manifest.Id);
        Assert.True(stored.IsDeleted);
        Assert.Equal(2, stored.TombstoneProtocolVersion);
        Assert.Equal(reservation.ManifestSeq, stored.TombstoneSeq);
        Assert.Equal(signedTargetVersion, stored.TombstoneVersionCreated);
        Assert.Equal(8, stored.VersionCreated);
        Assert.NotNull((await db.ManifestSequenceReservations.FindAsync(reservation.ReservationId))!.ConsumedAt);
    }

    [Fact]
    public async Task Finalize_RejectsV1WriteWithoutSequenceReservation()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var request = CreateFinalizeRequest(album.Id, shard);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: Convert.FromBase64String(request.SignerPubkey));
        var controller = CreateManifestsController(db);

        var result = await controller.Finalize(Guid.CreateVersion7(), request);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, problem.StatusCode);
        Assert.Empty(await db.Manifests.ToListAsync());
    }

    [Fact]
    public async Task Finalize_RejectsPerPhotoExpirationWithoutConsumingReservation()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var manifestId = Guid.CreateVersion7();
        var request = CreateFinalizeRequest(album.Id, shard) with
        {
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(1)
        };
        await builder.CreateEpochKeyAsync(
            album,
            owner,
            signPubkey: Convert.FromBase64String(request.SignerPubkey));
        var controller = CreateManifestsController(db);
        request = await ReserveCreateSequenceAsync(controller, album.Id, manifestId, request);

        var result = await controller.Finalize(manifestId, request);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, problem.StatusCode);
        Assert.Contains(
            "deferred",
            Assert.IsType<ProblemDetails>(problem.Value).Detail,
            StringComparison.OrdinalIgnoreCase);
        Assert.Empty(await db.Manifests.ToListAsync());
        Assert.Null((await db.ManifestSequenceReservations
            .SingleAsync(reservation => reservation.Id == request.SequenceReservationId)).ConsumedAt);
        var state = await db.ManifestSequenceStates.FindAsync(album.Id, request.SignerPubkey);
        Assert.Equal(0, state!.LastConsumedSequence);
    }

    [Fact]
    public async Task Finalize_RejectsUnsupportedProtocolVersion()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var request = CreateFinalizeRequest(album.Id, shard) with { ProtocolVersion = 2 };
        var controller = CreateManifestsController(db);

        var result = await controller.Finalize(Guid.CreateVersion7(), request);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, problem.StatusCode);
    }

    private static async Task<CreateManifestRequest> ReserveCreateSequenceAsync(
        ManifestsController controller,
        Guid albumId,
        Guid manifestId,
        CreateManifestRequest request)
    {
        var reservation = await ReserveSequenceAsync(
            controller,
            albumId,
            request.SignerPubkey,
            manifestId,
            ManifestSequenceOperations.Create);
        return request with
        {
            ManifestSeq = reservation.ManifestSeq,
            SequenceReservationId = reservation.ReservationId
        };
    }

    private static async Task<ManifestSequenceReservationResponse> ReserveSequenceAsync(
        ManifestsController controller,
        Guid albumId,
        string signerPubkey,
        Guid manifestId,
        string operationKind,
        Guid? operationId = null)
    {
        var reserveResult = await controller.ReserveSequence(new ReserveManifestSequenceRequest(
            albumId,
            signerPubkey,
            manifestId,
            operationId ?? Guid.CreateVersion7(),
            operationKind));
        var ok = Assert.IsType<OkObjectResult>(reserveResult);
        return Assert.IsType<ManifestSequenceReservationResponse>(ok.Value);
    }

    private static AlbumsController CreateAlbumsController(MosaicDbContext db)
        => new(db, new MockQuotaSettingsService(), new MockCurrentUserService(db), Helpers.NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

    private static ManifestsController CreateManifestsController(
        MosaicDbContext db,
        IStorageService? storageService = null)
        => new(
            db,
            new MockQuotaSettingsService(),
            new MockCurrentUserService(db),
            NullLogger<ManifestsController>.Instance,
            storageService: storageService ?? new AlwaysReadableStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

    private static CreateManifestRequest CreateFinalizeRequest(Guid albumId, Shard shard)
        => new(
            ProtocolVersion: 1,
            AlbumId: albumId,
            AssetType: "Image",
            EncryptedMeta: TestDataBuilder.GenerateRandomBytes(32),
            EncryptedMetaSidecar: null,
            Signature: Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            SignerPubkey: Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(32)),
            ShardIds: [],
            TieredShards: [ToTieredShard(shard, ShardTier.Original)]);

    private static TieredShardInfo ToTieredShard(Shard shard, ShardTier tier)
        => new(
            shard.Id.ToString(),
            (int)tier,
            ShardIndex: 0,
            Sha256: shard.Sha256,
            ContentLength: shard.SizeBytes,
            EnvelopeVersion: 3);

    private static string ToShapeJson(object value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        using var document = JsonDocument.Parse(json);
        var shape = ToShape(document.RootElement);
        return JsonSerializer.Serialize(shape, JsonOptions);
    }

    private static object? ToShape(JsonElement element)
        => element.ValueKind switch
        {
            JsonValueKind.Object => element.EnumerateObject()
                .ToDictionary(property => property.Name, property => ToShape(property.Value)),
            JsonValueKind.Array => element.GetArrayLength() == 0
                ? Array.Empty<object>()
                : new[] { ToShape(element.EnumerateArray().First()) },
            JsonValueKind.String => "string",
            JsonValueKind.Number => "number",
            JsonValueKind.True or JsonValueKind.False => "boolean",
            JsonValueKind.Null => "null",
            _ => element.ValueKind.ToString()
        };

    private sealed class AlwaysReadableStorageService : IStorageService
    {
        public Task<Stream> OpenReadAsync(string key)
            => Task.FromResult<Stream>(new MemoryStream([0x01]));

        public Task DeleteAsync(string key)
            => Task.CompletedTask;
    }

    private static void AssertContract(string snapshotName, string actualShapeJson)
    {
        var snapshotPath = Path.Combine(AppContext.BaseDirectory, "Snapshots", snapshotName);
        var expected = File.ReadAllText(snapshotPath).ReplaceLineEndings("\n").Trim();
        var actual = actualShapeJson.ReplaceLineEndings("\n").Trim();
        Assert.Equal(expected, actual);
    }
}
