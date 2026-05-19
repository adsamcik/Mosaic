using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using Mosaic.Backend.Tests.TestHelpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class AlbumsSyncShapeTests
{
    private const string OwnerAuthSub = "album-sync-shape-owner";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    [Fact]
    public async Task Sync_ReturnsFullShardProjectionForManifests()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 10);
        var thumb = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 111);
        var preview = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE, sizeBytes: 222);
        var manifest = await builder.CreateManifestAsync(album, [preview, thumb], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        manifest.VersionCreated = 11;
        album.CurrentVersion = 11;

        var links = db.ManifestShards
            .Where(ms => ms.ManifestId == manifest.Id)
            .OrderBy(ms => ms.ChunkIndex)
            .ToList();
        links[0].Tier = (int)ShardTier.Preview;
        links[0].ShardIndex = 0;
        links[0].Sha256 = preview.Sha256!;
        links[0].ContentLength = preview.SizeBytes;
        links[0].EnvelopeVersion = 3;
        links[1].Tier = (int)ShardTier.Thumb;
        links[1].ShardIndex = 0;
        links[1].Sha256 = thumb.Sha256!;
        links[1].ContentLength = thumb.SizeBytes;
        links[1].EnvelopeVersion = 3;
        await db.SaveChangesAsync();

        var controller = new AlbumsController(db, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = { HttpContext = TestHttpContext.Create(OwnerAuthSub) }
        };

        var result = await controller.Sync(album.Id, since: 10);

        var ok = Assert.IsType<OkObjectResult>(result);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(ok.Value, JsonOptions));
        var manifestElement = Assert.Single(document.RootElement.GetProperty("manifests").EnumerateArray());
        var shards = manifestElement.GetProperty("shards").EnumerateArray().ToArray();
        Assert.Equal(2, shards.Length);
        AssertShard(shards[0], preview.Id, (int)ShardTier.Preview, 0, preview.Sha256!, preview.SizeBytes, 3);
        AssertShard(shards[1], thumb.Id, (int)ShardTier.Thumb, 0, thumb.Sha256!, thumb.SizeBytes, 3);

        // sync-500 regression: the frontend SyncResponseSchema /
        // ManifestRecordSchema (apps/web/src/lib/api-schemas.ts) requires
        // `createdAt` as a non-null ISO datetime and accepts `updatedAt`
        // nullish. Dropping either from this projection causes the
        // ApiClient to throw "Invalid response shape" (synthesized as
        // ApiError 500) and breaks every post-mutation sync path
        // (uploads, renames, album-content fetch, format conversion).
        var createdAt = manifestElement.GetProperty("createdAt").GetString();
        Assert.False(string.IsNullOrEmpty(createdAt));
        Assert.True(
            DateTime.TryParse(createdAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out _),
            $"createdAt must be ISO-8601 parseable, got: {createdAt}");
        var updatedAt = manifestElement.GetProperty("updatedAt").GetString();
        Assert.False(string.IsNullOrEmpty(updatedAt));
        Assert.True(
            DateTime.TryParse(updatedAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out _),
            $"updatedAt must be ISO-8601 parseable when present, got: {updatedAt}");
    }

    private static void AssertShard(
        JsonElement shard,
        Guid shardId,
        int tier,
        int shardIndex,
        string sha256,
        long contentLength,
        int envelopeVersion)
    {
        Assert.Equal(shardId, shard.GetProperty("shardId").GetGuid());
        Assert.Equal(tier, shard.GetProperty("tier").GetInt32());
        Assert.Equal(shardIndex, shard.GetProperty("shardIndex").GetInt32());
        Assert.Equal(sha256, shard.GetProperty("sha256").GetString());
        Assert.Equal(contentLength, shard.GetProperty("contentLength").GetInt64());
        Assert.Equal(envelopeVersion, shard.GetProperty("envelopeVersion").GetInt32());
    }
}
