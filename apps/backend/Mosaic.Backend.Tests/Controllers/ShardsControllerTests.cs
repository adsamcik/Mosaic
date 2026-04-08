using Microsoft.AspNetCore.Mvc;
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
    public async Task Download_SetsCacheControlHeaders_WhenSuccessful()
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

        // Verify caching headers are set (shards are immutable)
        Assert.Equal("public, max-age=31536000, immutable", httpContext.Response.Headers.CacheControl.ToString());
        Assert.Equal($"\"{shard.Id}\"", httpContext.Response.Headers.ETag.ToString());
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
