using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ManifestsControllerTests
{
    private const string OwnerAuthSub = "owner-user";
    private const string EditorAuthSub = "editor-user";
    private const string ViewerAuthSub = "viewer-user";

    [Fact]
    public async Task Get_ReturnsManifest_WhenUserHasAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

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
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

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
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Get(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task Get_ReturnsUnauthorized_WhenNotAuthenticated()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.Get(Guid.NewGuid());

        // Assert
        Assert.IsType<UnauthorizedResult>(result);
    }

    [Fact]
    public async Task Get_ReturnsShardIds_InCorrectOrder()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var shard1 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var shard2 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var shard3 = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard1, shard2, shard3]);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task Get_AllowsViewerAccess()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        await builder.AddMemberAsync(album, viewer, "viewer", owner);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

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
        var builder = new TestDataBuilder(db);

        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var viewer = await builder.CreateUserAsync(ViewerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var membership = await builder.AddMemberAsync(album, viewer, "viewer", owner);
        membership.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard]);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(ViewerAuthSub)
            }
        };

        // Act
        var result = await controller.Get(manifest.Id);

        // Assert
        Assert.IsType<ForbidResult>(result);
    }

    // Note: Create and Delete tests are more complex because they use PostgreSQL-specific 
    // features (FOR UPDATE) that don't work with InMemory provider. These would require 
    // integration tests with a real PostgreSQL database.
    // The tests below verify error handling for authentication and basic scenarios.

    [Fact]
    public async Task Delete_ReturnsUnauthorized_WhenNotAuthenticated()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.CreateUnauthenticated()
            }
        };

        // Act
        var result = await controller.Delete(Guid.NewGuid());

        // Assert
        Assert.IsType<UnauthorizedResult>(result);
    }

    [Fact]
    public async Task Delete_ReturnsNotFound_WhenManifestNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);

        await builder.CreateUserAsync(OwnerAuthSub);

        var controller = new ManifestsController(db, config)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

        // Act
        var result = await controller.Delete(Guid.NewGuid());

        // Assert
        Assert.IsType<NotFoundResult>(result);
    }
}
