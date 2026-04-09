using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Models.Users;
using Mosaic.Backend.Tests.Helpers;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class UsersControllerTests
{
    private const string TestAuthSub = "test-user-123";

    [Fact]
    public async Task GetMe_CreatesNewUser_WhenNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.GetMe();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);

        // Verify user was created
        Assert.Single(db.Users);
        Assert.Single(db.UserQuotas);
    }

    [Fact]
    public async Task GetMe_ReturnsExistingUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub, "existing-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.GetMe();

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
        Assert.Single(db.Users);
    }

    [Fact]
    public async Task UpdateMe_SetsIdentityPubkey_WhenEmpty()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(IdentityPubkey: "new-pubkey-123");

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var user = db.Users.First();
        Assert.Equal("new-pubkey-123", user.IdentityPubkey);
    }

    [Fact]
    public async Task UpdateMe_ReturnsBadRequest_WhenIdentityPubkeyAlreadySet()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub, "existing-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(IdentityPubkey: "different-pubkey");

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task UpdateMe_AllowsSamePubkey()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub, "existing-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(IdentityPubkey: "existing-pubkey");

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task UpdateMe_SetsEncryptedSalt_WhenBothProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var encryptedSalt = Convert.ToBase64String(new byte[32]);
        var saltNonce = Convert.ToBase64String(new byte[12]);

        var request = new UpdateUserRequest(
            EncryptedSalt: encryptedSalt,
            SaltNonce: saltNonce);

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var user = db.Users.First();
        Assert.NotNull(user.EncryptedSalt);
        Assert.NotNull(user.SaltNonce);
    }

    [Fact]
    public async Task UpdateMe_ReturnsBadRequest_WhenOnlySaltProvided()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(
            EncryptedSalt: Convert.ToBase64String(new byte[32]));

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task UpdateMe_ReturnsBadRequest_WhenInvalidNonceLength()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(
            EncryptedSalt: Convert.ToBase64String(new byte[32]),
            SaltNonce: Convert.ToBase64String(new byte[10])); // Should be 12

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task UpdateMe_ReturnsBadRequest_WhenInvalidBase64()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(
            EncryptedSalt: "not-valid-base64!!!",
            SaltNonce: Convert.ToBase64String(new byte[12]));

        // Act
        var result = await controller.UpdateMe(request);

        // Assert
        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task GetUser_ReturnsUser_WhenExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync(TestAuthSub, "test-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("caller-user")
            }
        };

        // Act
        var result = await controller.GetUser(user.Id);

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task GetUser_ReturnsNotFound_WhenNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.GetUser(Guid.NewGuid());

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task GetUserByPubkey_ReturnsUser_WhenExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub, "my-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create("caller-user")
            }
        };

        // Act
        var result = await controller.GetUserByPubkey("my-pubkey");

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(okResult.Value);
    }

    [Fact]
    public async Task GetUserByPubkey_ReturnsNotFound_WhenNotExists()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        // Act
        var result = await controller.GetUserByPubkey("nonexistent-pubkey");

        // Assert
        ProblemDetailsAssertions.AssertNotFound(result);
    }
}
