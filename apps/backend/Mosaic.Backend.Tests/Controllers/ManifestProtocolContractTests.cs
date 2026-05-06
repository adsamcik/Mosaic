using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Manifests;
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
            expectedSha256 = document.RootElement.GetProperty("expectedSha256")
        };
        Assert.Equal(album.Id, syncShape.albumId.GetGuid());
        Assert.Equal(42, syncShape.currentVersion.GetInt64());
        Assert.Equal(manifest.Id, syncShape.manifestId.GetGuid());
        Assert.Equal($"/api/manifests/{manifest.Id}", syncShape.manifestUrl.GetString());
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

        var controller = CreateManifestsController(db);

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
    public async Task Finalize_CommitsMonotonicAlbumManifestVersions()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        var controller = CreateManifestsController(db);

        var firstShard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 11);
        var first = await controller.Finalize(Guid.CreateVersion7(), CreateFinalizeRequest(album.Id, firstShard));
        Assert.IsType<CreatedResult>(first);

        var secondShard = await builder.CreateShardAsync(owner, ShardStatus.PENDING, sizeBytes: 12);
        var second = await controller.Finalize(Guid.CreateVersion7(), CreateFinalizeRequest(album.Id, secondShard));
        Assert.IsType<CreatedResult>(second);

        var versions = db.Manifests.OrderBy(m => m.VersionCreated).Select(m => m.VersionCreated).ToArray();
        Assert.Equal([8, 9], versions);
        Assert.Equal(9, db.Albums.Single(a => a.Id == album.Id).CurrentVersion);
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

    private static AlbumsController CreateAlbumsController(MosaicDbContext db)
        => new(db, new MockQuotaSettingsService(), new MockCurrentUserService(db), Helpers.NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

    private static ManifestsController CreateManifestsController(MosaicDbContext db)
        => new(db, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLogger<ManifestsController>.Instance)
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

    private static void AssertContract(string snapshotName, string actualShapeJson)
    {
        var snapshotPath = Path.Combine(AppContext.BaseDirectory, "Snapshots", snapshotName);
        var expected = File.ReadAllText(snapshotPath).ReplaceLineEndings("\n").Trim();
        var actual = actualShapeJson.ReplaceLineEndings("\n").Trim();
        Assert.Equal(expected, actual);
    }
}
