using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Photos;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class PhotoTieredShardsContractTests
{
    private const string OwnerAuthSub = "tier-owner";
    private const string MemberAuthSub = "tier-member";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    [Theory]
    [InlineData("own")]
    [InlineData("shared")]
    public async Task AlbumPhotoEndpoints_LegacyAccept_ReturnFlatShardListOnly(string endpoint)
    {
        using var db = TestDbContextFactory.Create();
        var (album, _) = await SeedAlbumPhotosAsync(db);
        var authSub = endpoint == "shared" ? MemberAuthSub : OwnerAuthSub;
        var controller = CreateAlbumsController(db, authSub);

        var result = await controller.GetPhotos(album.Id);

        var photo = AssertSinglePhoto(result);
        Assert.NotNull(photo.ShardIds);
        Assert.Null(photo.TieredShards);
        AssertContract("album-photos-legacy.contract.json", ToShapeJson(photo));
    }

    [Theory]
    [InlineData("own")]
    [InlineData("shared")]
    public async Task AlbumPhotoEndpoints_TieredAccept_ReturnTieredShardsContract(string endpoint)
    {
        using var db = TestDbContextFactory.Create();
        var (album, shards) = await SeedAlbumPhotosAsync(db);
        var authSub = endpoint == "shared" ? MemberAuthSub : OwnerAuthSub;
        var controller = CreateAlbumsController(db, authSub);
        controller.Request.Headers.Accept = PhotoResponseFactory.TieredShardsMediaType;

        var result = await controller.GetPhotos(album.Id);

        var photo = AssertSinglePhoto(result);
        Assert.NotNull(photo.ShardIds);
        Assert.NotNull(photo.TieredShards);
        Assert.Equal(shards.Thumb.Id, photo.TieredShards.Thumb.Single());
        Assert.Equal(shards.Preview.Id, photo.TieredShards.Preview.Single());
        Assert.Equal(shards.Original.Id, photo.TieredShards.Original.Single());
        AssertContract("album-photos-tiered.contract.json", ToShapeJson(photo));
    }

    [Fact]
    public async Task ShareLinkPhotos_LegacyAccept_ReturnFlatShardListOnly()
    {
        using var db = TestDbContextFactory.Create();
        var (_, shareLink, _) = await SeedShareLinkPhotosAsync(db);
        var controller = CreateShareLinkAccessController(db);

        var result = await controller.GetPhotos(ToBase64Url(shareLink.LinkId));

        var photo = AssertSinglePhoto(result);
        Assert.NotNull(photo.ShardIds);
        Assert.Null(photo.TieredShards);
        AssertContract("share-link-photos-legacy.contract.json", ToShapeJson(photo));
    }

    [Fact]
    public async Task ShareLinkPhotos_TieredAccept_ReturnTieredShardsContract()
    {
        using var db = TestDbContextFactory.Create();
        var (_, shareLink, shards) = await SeedShareLinkPhotosAsync(db);
        var controller = CreateShareLinkAccessController(db);
        controller.Request.Headers.Accept = PhotoResponseFactory.TieredShardsMediaType;

        var result = await controller.GetPhotos(ToBase64Url(shareLink.LinkId));

        var photo = AssertSinglePhoto(result);
        Assert.NotNull(photo.TieredShards);
        Assert.Equal(shards.Thumb.Id, photo.TieredShards.Thumb.Single());
        Assert.Equal(shards.Preview.Id, photo.TieredShards.Preview.Single());
        Assert.Equal(shards.Original.Id, photo.TieredShards.Original.Single());
        AssertContract("share-link-photos-tiered.contract.json", ToShapeJson(photo));
    }

    private static AlbumsController CreateAlbumsController(Mosaic.Backend.Data.MosaicDbContext db, string authSub)
        => new(db, new MockQuotaSettingsService(), new MockCurrentUserService(db), NullLoggerFactory.CreateNullLogger<AlbumsController>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(authSub)
            }
        };

    private static ShareLinkAccessController CreateShareLinkAccessController(Mosaic.Backend.Data.MosaicDbContext db)
        => new(db, TestConfiguration.Create(), new MockStorageService())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

    private static async Task<(Album Album, (Shard Thumb, Shard Preview, Shard Original) Shards)> SeedAlbumPhotosAsync(Mosaic.Backend.Data.MosaicDbContext db)
    {
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var member = await builder.CreateUserAsync(MemberAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, member, AlbumRoles.Viewer, owner);
        var shards = await CreateTieredManifestAsync(builder, db, owner, album);
        return (album, shards);
    }

    private static async Task<(Album Album, ShareLink ShareLink, (Shard Thumb, Shard Preview, Shard Original) Shards)> SeedShareLinkPhotosAsync(Mosaic.Backend.Data.MosaicDbContext db)
    {
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shards = await CreateTieredManifestAsync(builder, db, owner, album);
        var shareLink = await builder.CreateShareLinkAsync(album, accessTier: (int)ShardTier.Original);
        return (album, shareLink, shards);
    }

    private static async Task<(Shard Thumb, Shard Preview, Shard Original)> CreateTieredManifestAsync(
        TestDataBuilder builder,
        Mosaic.Backend.Data.MosaicDbContext db,
        User owner,
        Album album)
    {
        var thumb = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var preview = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var original = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [thumb, preview, original]);
        var links = db.ManifestShards.Where(ms => ms.ManifestId == manifest.Id).OrderBy(ms => ms.ChunkIndex).ToList();
        links[0].Tier = (int)ShardTier.Thumb;
        links[1].Tier = (int)ShardTier.Preview;
        links[2].Tier = (int)ShardTier.Original;
        await db.SaveChangesAsync();
        return (thumb, preview, original);
    }

    private static PhotoResponse AssertSinglePhoto(IActionResult result)
    {
        var ok = Assert.IsType<OkObjectResult>(result);
        var photos = Assert.IsAssignableFrom<IReadOnlyCollection<PhotoResponse>>(ok.Value);
        return Assert.Single(photos);
    }

    private static string ToShapeJson(PhotoResponse photo)
    {
        var json = JsonSerializer.Serialize(photo, JsonOptions);
        using var document = JsonDocument.Parse(json);
        var shape = ToShape(document.RootElement);
        return JsonSerializer.Serialize(shape, JsonOptions);
    }

    private static object? ToShape(JsonElement element)
    {
        return element.ValueKind switch
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
    }

    private static void AssertContract(string snapshotName, string actualShapeJson)
    {
        var snapshotPath = Path.Combine(AppContext.BaseDirectory, "Snapshots", snapshotName);
        var expected = File.ReadAllText(snapshotPath).ReplaceLineEndings("\n").Trim();
        var actual = actualShapeJson.ReplaceLineEndings("\n").Trim();
        Assert.Equal(expected, actual);
    }

    private static string ToBase64Url(byte[] bytes)
        => Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
}
