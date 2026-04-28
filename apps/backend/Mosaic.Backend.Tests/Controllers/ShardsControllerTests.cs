using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ShardsControllerTests
{
    private const string UploaderAuthSub = "uploader-user";
    private const string ViewerAuthSub = "viewer-user";

    [Fact]
    public async Task Download_ReturnsOpaqueBytesUnchanged_WhenPayloadIsNotImageData()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        var encryptedPayload = new byte[] { 0xff, 0x00, 0x7b, 0x22, 0x6e, 0x6f, 0x74, 0x2d, 0x6a, 0x70, 0x65, 0x67, 0x22, 0x7d };
        storage.AddFile(shard.StorageKey, encryptedPayload);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        var fileResult = Assert.IsType<FileStreamResult>(result);
        Assert.Equal("application/octet-stream", fileResult.ContentType);

        using var copied = new MemoryStream();
        await fileResult.FileStream.CopyToAsync(copied);
        Assert.Equal(encryptedPayload, copied.ToArray());
    }

    [Fact]
    public async Task Download_ReturnsFile_WhenUserHasAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        storage.AddFile(shard.StorageKey, new byte[] { 0x01, 0x02, 0x03, 0x04 });

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        var fileResult = Assert.IsType<FileStreamResult>(result);
        Assert.Equal("application/octet-stream", fileResult.ContentType);
    }

    [Fact]
    public async Task Download_SetsNoStoreCacheHeaders_WhenSuccessful()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        storage.AddFile(shard.StorageKey, new byte[] { 0x01, 0x02, 0x03, 0x04 });

        var httpContext = TestHttpContext.Create(UploaderAuthSub);
        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        Assert.IsType<FileStreamResult>(result);

        Assert.Equal("no-store, no-cache, max-age=0", httpContext.Response.Headers.CacheControl.ToString());
        Assert.Equal("no-cache", httpContext.Response.Headers.Pragma.ToString());
        Assert.Equal("0", httpContext.Response.Headers.Expires.ToString());
        Assert.False(httpContext.Response.Headers.ContainsKey("ETag"));
        Assert.DoesNotContain("public", httpContext.Response.Headers.CacheControl.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("immutable", httpContext.Response.Headers.CacheControl.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Download_ReturnsUnauthorized_WhenNotAuthenticated()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.Download(Guid.NewGuid());

        // Assert
        Assert.IsType<UnauthorizedResult>(result);
    }

    [Fact]
    public async Task Download_ReturnsNotFound_WhenShardNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(UploaderAuthSub);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.Download(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Download_ReturnsNotFound_WhenShardNotActive()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.PENDING);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Download_ReturnsNotFound_WhenShardTrashed()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.TRASHED);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Download_ReturnsForbid_WhenUserNotMemberOfAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        storage.AddFile(shard.StorageKey);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task Download_AllowsAccess_WhenViewerMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        await builder.AddMemberAsync(album, viewer, "viewer", uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        storage.AddFile(shard.StorageKey, new byte[] { 0x01, 0x02, 0x03, 0x04 });

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

        // Act
        var result = await controller.Download(shard.Id);

        // Assert
        Assert.IsType<FileStreamResult>(result);
    }

    [Fact]
    public async Task GetMeta_ReturnsOnlySafeOpaqueShardMetadata()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.PENDING, sizeBytes: 1024);
        shard.Sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        await db.SaveChangesAsync();

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.GetMeta(shard.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(okResult.Value));
        var root = json.RootElement;

        Assert.Equal(shard.Id, root.GetProperty("Id").GetGuid());
        Assert.Equal(shard.SizeBytes, root.GetProperty("SizeBytes").GetInt64());
        Assert.Equal(shard.Sha256, root.GetProperty("Sha256").GetString());
        Assert.True(root.TryGetProperty("Status", out _));
        Assert.True(root.TryGetProperty("StatusUpdatedAt", out _));
        Assert.False(root.TryGetProperty("StorageKey", out _));
        Assert.False(root.TryGetProperty("Content", out _));
        Assert.False(root.TryGetProperty("EncryptedContent", out _));
        Assert.False(root.TryGetProperty("Preview", out _));
    }

    [Fact]
    public async Task GetMeta_ReturnsMeta_WhenUploader()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.PENDING, sizeBytes: 1024);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.GetMeta(shard.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task GetMeta_ReturnsUnauthorized_WhenNotAuthenticated()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.GetMeta(Guid.NewGuid());

        // Assert
        Assert.IsType<UnauthorizedResult>(result);
    }

    [Fact]
    public async Task GetMeta_ReturnsNotFound_WhenShardNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(UploaderAuthSub);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(UploaderAuthSub)
            }
        };

        // Act
        var result = await controller.GetMeta(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task GetMeta_ReturnsForbid_WhenNeitherUploaderNorMember()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

        // Act
        var result = await controller.GetMeta(shard.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    [Fact]
    public async Task GetMeta_AllowsAccess_WhenMemberOfAlbum()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var storage = new MockStorageService();
        var builder = new TestDataBuilder(db);

        var uploader = await builder.CreateUserAsync(UploaderAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(uploader);
        await builder.AddMemberAsync(album, viewer, "viewer", uploader);
        var shard = await builder.CreateShardAsync(uploader, ShardStatus.ACTIVE);
        await builder.CreateManifestAsync(album, [shard]);

        var controller = new ShardsController(db, storage, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

        // Act
        var result = await controller.GetMeta(shard.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }
}
