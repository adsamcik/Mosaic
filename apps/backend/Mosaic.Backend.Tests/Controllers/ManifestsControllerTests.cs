using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text;
using System.Text.Json;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Mosaic.Backend.Tests.TestHelpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ManifestsControllerTests
{
    private const string OwnerAuthSub = "owner-user";
    private const string EditorAuthSub = "editor-user";
    private const string ViewerAuthSub = "viewer-user";

    private static ManifestsController CreateController(
        MosaicDbContext db,
        IConfiguration config,
        IQuotaSettingsService quotaService,
        string authSub)
    {
        return new ManifestsController(db, quotaService, new MockCurrentUserService(db), NullLogger<ManifestsController>.Instance)
        {
            ControllerContext = { HttpContext = TestHttpContext.Create(authSub) }
        };
    }

    [Fact]
    public async Task Create_AcceptsAndroidOnePhotoOpaqueManifest_WithoutEchoingOpaqueFields()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 4096);
        var plaintextSentinel = "android-cleartext-filename=IMG_0001.jpg;gps=50.087,14.421";
        var encryptedMeta = Encoding.UTF8.GetBytes(plaintextSentinel);
        var signature = Convert.ToBase64String(Encoding.UTF8.GetBytes("android-signature-opaque-contract"));
        var signerPubkey = Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(32));
        var encryptedMetaBase64 = Convert.ToBase64String(encryptedMeta);
        var request = new CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: encryptedMeta,
            Signature: signature,
            SignerPubkey: signerPubkey,
            ShardIds: [],
            TieredShards: [new TieredShardInfo(shard.Id.ToString(), (int)ShardTier.Original)]);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        // Act
        var createResult = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(createResult);
        var responseJson = JsonSerializer.Serialize(createdResult.Value);
        Assert.DoesNotContain(plaintextSentinel, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(encryptedMetaBase64, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(signature, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(signerPubkey, responseJson, StringComparison.Ordinal);

        var manifestId = GetResponseProperty<Guid>(createdResult.Value, "Id");
        var persisted = await db.Manifests.SingleAsync(m => m.Id == manifestId);
        Assert.Equal(encryptedMeta, persisted.EncryptedMeta);
        Assert.Equal(signature, persisted.Signature);
        Assert.Equal(signerPubkey, persisted.SignerPubkey);

        var manifestShard = await db.ManifestShards.SingleAsync(ms => ms.ManifestId == manifestId);
        Assert.Equal(shard.Id, manifestShard.ShardId);
        Assert.Equal((int)ShardTier.Original, manifestShard.Tier);
        Assert.Equal(ShardStatus.ACTIVE, (await db.Shards.SingleAsync(s => s.Id == shard.Id)).Status);
    }

    [Fact]
    public async Task Create_AcceptsCrossClientManualUploadFixture_AndPreservesOpaqueFields()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var fixture = LoadCrossClientContractFixture();
        var manifestRequest = fixture.GetProperty("backendManifestRequest");
        var androidHandoff = fixture.GetProperty("androidHandoff");
        var clientCore = fixture.GetProperty("clientCore");
        var albumId = Guid.Parse(FixtureString(manifestRequest, "albumId"));
        var encryptedMeta = Convert.FromBase64String(FixtureString(manifestRequest, "encryptedMetaBase64"));
        var signature = FixtureString(manifestRequest, "signature");
        var signerPubkey = FixtureString(manifestRequest, "signerPubkey");
        var tieredShards = FixtureTieredShards(manifestRequest);
        var shardIds = tieredShards.Select(shard => shard.ShardId).ToList();

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        db.Albums.Add(new Album
        {
            Id = albumId,
            OwnerId = owner.Id,
            CurrentEpochId = FixtureInt(clientCore, "epochId"),
            CurrentVersion = FixtureLong(clientCore.GetProperty("manifestReceipt"), "version") - 1,
            EncryptedName = "opaque-album-name"
        });
        db.AlbumMembers.Add(new AlbumMember
        {
            AlbumId = albumId,
            UserId = owner.Id,
            Role = AlbumRoles.Owner
        });
        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = albumId,
            CurrentPhotoCount = 0,
            CurrentSizeBytes = 0
        });

        foreach (var tieredShard in tieredShards)
        {
            db.Shards.Add(new Shard
            {
                Id = Guid.Parse(tieredShard.ShardId),
                UploaderId = owner.Id,
                StorageKey = $"band3-contract/{tieredShard.ShardId}",
                SizeBytes = FixtureLong(androidHandoff, "byteCount") / tieredShards.Count,
                Status = ShardStatus.PENDING
            });
        }
        await db.SaveChangesAsync();

        var request = new CreateManifestRequest(
            AlbumId: albumId,
            EncryptedMeta: encryptedMeta,
            Signature: signature,
            SignerPubkey: signerPubkey,
            ShardIds: shardIds,
            TieredShards: tieredShards);
        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        // Act
        var createResult = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(createResult);
        var responseJson = JsonSerializer.Serialize(createdResult.Value);
        foreach (var forbidden in FixtureForbiddenPlaintextTerms(fixture))
        {
            Assert.DoesNotContain(forbidden, responseJson, StringComparison.Ordinal);
            Assert.DoesNotContain(forbidden, JsonSerializer.Serialize(request), StringComparison.Ordinal);
        }
        Assert.DoesNotContain(FixtureString(manifestRequest, "encryptedMetaBase64"), responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(signature, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(signerPubkey, responseJson, StringComparison.Ordinal);

        var manifestId = GetResponseProperty<Guid>(createdResult.Value, "Id");
        var persisted = await db.Manifests.SingleAsync(m => m.Id == manifestId);
        Assert.Equal(albumId, persisted.AlbumId);
        Assert.Equal(encryptedMeta, persisted.EncryptedMeta);
        Assert.Equal(signature, persisted.Signature);
        Assert.Equal(signerPubkey, persisted.SignerPubkey);
        Assert.Equal(FixtureLong(clientCore.GetProperty("manifestReceipt"), "version"), persisted.VersionCreated);

        var linkedShards = await db.ManifestShards
            .Where(ms => ms.ManifestId == manifestId)
            .OrderBy(ms => ms.ChunkIndex)
            .ToListAsync();
        Assert.Equal(tieredShards.Count, linkedShards.Count);
        for (var index = 0; index < tieredShards.Count; index++)
        {
            Assert.Equal(Guid.Parse(tieredShards[index].ShardId), linkedShards[index].ShardId);
            Assert.Equal(tieredShards[index].Tier, linkedShards[index].Tier);
            Assert.Equal(ShardStatus.ACTIVE, (await db.Shards.SingleAsync(s => s.Id == linkedShards[index].ShardId)).Status);
        }
    }

    [Fact]
    public async Task Create_ReturnsGenericShardError_WithoutEchoingOpaqueAndroidManifestFields()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var plaintextSentinel = "android-cleartext-title=Hidden place;gps=50.087,14.421";
        var encryptedMeta = Encoding.UTF8.GetBytes(plaintextSentinel);
        var encryptedMetaBase64 = Convert.ToBase64String(encryptedMeta);
        var signature = Convert.ToBase64String(Encoding.UTF8.GetBytes("android-error-signature-opaque-contract"));
        var signerPubkey = Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(32));
        var request = new CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: encryptedMeta,
            Signature: signature,
            SignerPubkey: signerPubkey,
            ShardIds: [],
            TieredShards:
            [
                new TieredShardInfo(
                    Guid.NewGuid().ToString(),
                    (int)ShardTier.Original,
                    Sha256: TestDataBuilder.TestSha256Hex(),
                    ContentLength: 1024)
            ]);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        // Act
        var createResult = await controller.Create(request);

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(createResult);
        Assert.Equal("Some shards not found", ProblemDetailsAssertions.GetDetail(badRequest));
        var responseJson = JsonSerializer.Serialize(badRequest.Value);
        Assert.DoesNotContain(plaintextSentinel, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(encryptedMetaBase64, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(signature, responseJson, StringComparison.Ordinal);
        Assert.DoesNotContain(signerPubkey, responseJson, StringComparison.Ordinal);
        Assert.Empty(await db.Manifests.ToListAsync());
    }

    [Fact]
    public async Task Create_ReturnsForbidForViewer_AndDoesNotPersistAndroidManifest()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, AlbumRoles.Viewer, owner);
        var shard = await builder.CreateShardAsync(viewer, ShardStatus.PENDING, sizeBytes: 4096);
        var encryptedMeta = Encoding.UTF8.GetBytes("viewer opaque metadata should remain unpersisted");
        var request = new CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: encryptedMeta,
            Signature: Convert.ToBase64String(Encoding.UTF8.GetBytes("viewer-signature-should-stay-opaque")),
            SignerPubkey: Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(32)),
            ShardIds: [],
            TieredShards: [new TieredShardInfo(shard.Id.ToString(), (int)ShardTier.Original)]);

        var controller = CreateController(db, config, quotaService, ViewerAuthSub);

        // Act
        var createResult = await controller.Create(request);

        // Assert
        var forbid = Assert.IsType<ForbidResult>(createResult);
        Assert.Empty(forbid.AuthenticationSchemes);
        Assert.Empty(await db.Manifests.ToListAsync());
        Assert.Equal(ShardStatus.PENDING, (await db.Shards.SingleAsync(s => s.Id == shard.Id)).Status);
    }

    [Fact]
    public async Task Create_StoresAndReturnsEncryptedMetaAsOpaqueBytes()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 17);
        var encryptedMeta = new byte[]
        {
            0xff, 0x00, 0x7b, 0x22, 0x67, 0x70, 0x73, 0x22, 0x3a, 0x22, 0x6e, 0x6f, 0x74, 0x2d, 0x70, 0x6c, 0x61, 0x69, 0x6e, 0x22, 0x7d
        };
        var request = new CreateManifestRequest(
            AlbumId: album.Id,
            EncryptedMeta: encryptedMeta,
            Signature: Convert.ToBase64String(new byte[64]),
            SignerPubkey: Convert.ToBase64String(new byte[32]),
            ShardIds: [],
            TieredShards: [new TieredShardInfo(shard.Id.ToString(), (int)ShardTier.Original)]);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        // Act
        var createResult = await controller.Create(request);

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(createResult);
        var manifestId = GetResponseProperty<Guid>(createdResult.Value, "Id");

        var persisted = await db.Manifests.SingleAsync(m => m.Id == manifestId);
        Assert.Equal(encryptedMeta, persisted.EncryptedMeta);
        Assert.Equal(ShardStatus.ACTIVE, (await db.Shards.SingleAsync(s => s.Id == shard.Id)).Status);

        var getResult = await controller.Get(manifestId);
        var okResult = Assert.IsType<OkObjectResult>(getResult);
        var returnedMeta = GetResponseProperty<byte[]>(okResult.Value, "EncryptedMeta");
        Assert.Equal(encryptedMeta, returnedMeta);
    }

    [Fact]
    public async Task Get_ReturnsManifest_WhenUserHasAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Get_ReturnsForbid_WhenUserNotMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, quotaService, ViewerAuthSub);

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Get_ReturnsNotFound_WhenManifestNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        // Act
        var result = await controller.Get(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Get_AllowsViewerAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, quotaService, ViewerAuthSub);

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Get_ReturnsForbid_WhenMembershipRevoked()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, viewer, "viewer", owner);
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, quotaService, ViewerAuthSub);

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    // Note: Create and Delete tests are more complex because they use PostgreSQL-specific 
    // features (FOR UPDATE) that don't work with InMemory provider. These would require 
    // integration tests with a real PostgreSQL database.

    [Fact]
    public async Task Delete_SoftDeletesManifestAndTrashesDetachedShards()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = album.Id,
            CurrentPhotoCount = 1,
            CurrentSizeBytes = 1024
        });
        await db.SaveChangesAsync();

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 1024);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        var result = await controller.Delete(manifest.Id);

        Assert.IsType<NoContentResult>(result);

        var deletedManifest = await db.Manifests
            .IgnoreQueryFilters()
            .SingleAsync(m => m.Id == manifest.Id);
        Assert.True(deletedManifest.IsDeleted);
        Assert.Empty(db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id));
        Assert.Equal(ShardStatus.TRASHED, db.Shards.Single(s => s.Id == shard.Id).Status);
    }

    [Fact]
    public async Task UpdateMetadata_OwnerCanUpdate_ReturnsOk_AndBumpsVersion()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        var newMeta = TestDataBuilder.GenerateRandomBytes(24);
        var previousVersion = album.CurrentVersion;

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);
        var request = CreateUpdateRequest(newMeta, signerPubkey);

        var result = await controller.UpdateMetadata(manifest.Id, request);

        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.Equal(previousVersion + 1, GetResponseProperty<long>(okResult.Value, "versionCreated"));

        var updatedManifest = await db.Manifests.SingleAsync(m => m.Id == manifest.Id);
        var updatedAlbum = await db.Albums.SingleAsync(a => a.Id == album.Id);
        Assert.Equal(newMeta, updatedManifest.EncryptedMeta);
        Assert.Equal(previousVersion + 1, updatedManifest.VersionCreated);
        Assert.Equal(previousVersion + 1, updatedAlbum.CurrentVersion);
    }

    [Fact]
    public async Task UpdateMetadata_EditorCanUpdate_ReturnsOk()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var editor = await builder.CreateUserAsync(EditorAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, editor, AlbumRoles.Editor, owner);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));

        var controller = CreateController(db, config, quotaService, EditorAuthSub);

        var result = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task UpdateMetadata_ViewerForbidden_Returns403()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, AlbumRoles.Viewer, owner);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));

        var controller = CreateController(db, config, quotaService, ViewerAuthSub);

        var result = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task UpdateMetadata_NonMemberReturns404()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));

        var controller = CreateController(db, config, quotaService, ViewerAuthSub);

        var result = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task UpdateMetadata_DeletedManifestReturns404()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], isDeleted: true, encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        var result = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task UpdateMetadata_UnknownSignerPubkeyReturns400()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: TestDataBuilder.GenerateRandomBytes(32));
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        var result = await controller.UpdateMetadata(
            manifest.Id,
            CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), TestDataBuilder.GenerateRandomBytes(32)));

        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Equal(
            "signerPubkey does not match any active epoch sign key for this album",
            ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task UpdateMetadata_DoesNotChangeShards_OrQuota()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        db.AlbumLimits.Add(new AlbumLimits
        {
            AlbumId = album.Id,
            CurrentPhotoCount = 1,
            CurrentSizeBytes = 4096
        });
        await db.SaveChangesAsync();
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard1 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 1024);
        var shard2 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 3072);
        var manifest = await builder.CreateManifestAsync(album, [shard1, shard2], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        var originalShards = await db.ManifestShards
            .Where(ms => ms.ManifestId == manifest.Id)
            .OrderBy(ms => ms.ChunkIndex)
            .Select(ms => new { ms.ManifestId, ms.ShardId, ms.ChunkIndex, ms.Tier })
            .ToListAsync();
        var originalLimits = await db.AlbumLimits.SingleAsync(al => al.AlbumId == album.Id);

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        var result = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<OkObjectResult>(result);
        var updatedShards = await db.ManifestShards
            .Where(ms => ms.ManifestId == manifest.Id)
            .OrderBy(ms => ms.ChunkIndex)
            .Select(ms => new { ms.ManifestId, ms.ShardId, ms.ChunkIndex, ms.Tier })
            .ToListAsync();
        var updatedLimits = await db.AlbumLimits.SingleAsync(al => al.AlbumId == album.Id);

        Assert.Equal(originalShards, updatedShards);
        Assert.Equal(originalLimits.CurrentPhotoCount, updatedLimits.CurrentPhotoCount);
        Assert.Equal(originalLimits.CurrentSizeBytes, updatedLimits.CurrentSizeBytes);
    }

    [Fact]
    public async Task UpdateMetadata_LastWriteWins_DocumentedBehaviour()
    {
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var quotaService = TestConfiguration.CreateQuotaService(db, config);
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 3);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        var firstMeta = TestDataBuilder.GenerateRandomBytes(20);
        var secondMeta = TestDataBuilder.GenerateRandomBytes(21);
        var originalVersion = album.CurrentVersion;

        var controller = CreateController(db, config, quotaService, OwnerAuthSub);

        var firstResult = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(firstMeta, signerPubkey));
        var secondResult = await controller.UpdateMetadata(manifest.Id, CreateUpdateRequest(secondMeta, signerPubkey));

        Assert.IsType<OkObjectResult>(firstResult);
        Assert.IsType<OkObjectResult>(secondResult);
        var updatedManifest = await db.Manifests.SingleAsync(m => m.Id == manifest.Id);
        var updatedAlbum = await db.Albums.SingleAsync(a => a.Id == album.Id);
        Assert.Equal(secondMeta, updatedManifest.EncryptedMeta);
        Assert.Equal(originalVersion + 2, updatedManifest.VersionCreated);
        Assert.Equal(originalVersion + 2, updatedAlbum.CurrentVersion);
    }

    private static T GetResponseProperty<T>(object? response, string propertyName)
    {
        Assert.NotNull(response);
        var property = response.GetType().GetProperty(propertyName);
        Assert.NotNull(property);
        return Assert.IsType<T>(property.GetValue(response));
    }

    private static UpdateManifestMetadataRequest CreateUpdateRequest(byte[] encryptedMeta, byte[] signerPubkey)
        => new(
            Convert.ToBase64String(encryptedMeta),
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            Convert.ToBase64String(signerPubkey));

    private static JsonElement LoadCrossClientContractFixture()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "tests",
                "contracts",
                "android-manual-upload-cross-client.json");
            if (File.Exists(candidate))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(candidate));
                return document.RootElement.Clone();
            }
            directory = directory.Parent;
        }

        throw new FileNotFoundException("Unable to locate android manual upload cross-client contract fixture");
    }

    private static string FixtureString(JsonElement element, string propertyName)
        => element.GetProperty(propertyName).GetString()
            ?? throw new InvalidOperationException($"Fixture property {propertyName} is missing");

    private static int FixtureInt(JsonElement element, string propertyName)
        => element.GetProperty(propertyName).GetInt32();

    private static long FixtureLong(JsonElement element, string propertyName)
        => element.GetProperty(propertyName).GetInt64();

    private static List<TieredShardInfo> FixtureTieredShards(JsonElement manifestRequest)
        => manifestRequest
            .GetProperty("tieredShards")
            .EnumerateArray()
            .Select(shard => new TieredShardInfo(
                FixtureString(shard, "shardId"),
                FixtureInt(shard, "tier")))
            .ToList();

    private static List<string> FixtureForbiddenPlaintextTerms(JsonElement fixture)
        => fixture
            .GetProperty("forbiddenPlaintextTerms")
            .EnumerateArray()
            .Select(term => term.GetString() ?? throw new InvalidOperationException("Fixture forbidden term is missing"))
            .ToList();
}
