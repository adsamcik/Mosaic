using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
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
    public async Task GetMe_ReturnsAccountSalt_WhenStored()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        var accountSalt = Enumerable.Range(1, 16).Select(i => (byte)i).ToArray();
        var user = await builder.CreateUserAsync(TestAuthSub, "existing-pubkey");
        user.AccountSalt = accountSalt;
        await db.SaveChangesAsync();

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
        var accountSaltProperty = okResult.Value!.GetType().GetProperty("AccountSalt");
        Assert.NotNull(accountSaltProperty);
        Assert.Equal(Convert.ToBase64String(accountSalt), accountSaltProperty.GetValue(okResult.Value));
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

    // ---------- v1.0.1 s23 — AuthSub topology leak on ProxyAuth deployments ----------

    private static IConfiguration CreateProxyAuthConfig()
    {
        var data = new Dictionary<string, string?>
        {
            ["Quota:DefaultMaxBytes"] = "10737418240",
            ["Quota:DefaultMaxAlbums"] = "100",
            ["Quota:DefaultMaxPhotosPerAlbum"] = "10000",
            ["Quota:DefaultMaxBytesPerAlbum"] = "5368709120",
            ["Storage:Path"] = Path.GetTempPath(),
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:LocalAuthEnabled"] = "false",
        };
        return new ConfigurationBuilder().AddInMemoryCollection(data).Build();
    }

    private static IConfiguration CreateLocalAuthConfig()
    {
        var data = new Dictionary<string, string?>
        {
            ["Quota:DefaultMaxBytes"] = "10737418240",
            ["Quota:DefaultMaxAlbums"] = "100",
            ["Quota:DefaultMaxPhotosPerAlbum"] = "10000",
            ["Quota:DefaultMaxBytesPerAlbum"] = "5368709120",
            ["Storage:Path"] = Path.GetTempPath(),
            ["Auth:ProxyAuthEnabled"] = "false",
            ["Auth:LocalAuthEnabled"] = "true",
        };
        return new ConfigurationBuilder().AddInMemoryCollection(data).Build();
    }

    private static bool ResponseHasProperty(object? value, string propertyName)
    {
        Assert.NotNull(value);
        return value!.GetType().GetProperty(propertyName) is not null;
    }

    [Fact]
    public async Task GetMe_ProxyAuthMode_OmitsAuthSubFromResponse()
    {
        using var db = TestDbContextFactory.Create();
        var config = CreateProxyAuthConfig();
        var dataBuilder = new TestDataBuilder(db);
        await dataBuilder.CreateUserAsync(TestAuthSub, "existing-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var result = await controller.GetMe();

        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.False(
            ResponseHasProperty(okResult.Value, "AuthSub"),
            "AuthSub MUST be omitted from /me response when Auth:ProxyAuthEnabled=true — it is the upstream Remote-User header value and leaks deployment topology.");
        Assert.True(ResponseHasProperty(okResult.Value, "Id"));
        Assert.True(ResponseHasProperty(okResult.Value, "IdentityPubkey"));
    }

    [Fact]
    public async Task GetMe_LocalAuthMode_IncludesAuthSubInResponse()
    {
        using var db = TestDbContextFactory.Create();
        var config = CreateLocalAuthConfig();
        var dataBuilder = new TestDataBuilder(db);
        await dataBuilder.CreateUserAsync(TestAuthSub, "existing-pubkey");

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var result = await controller.GetMe();

        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.True(
            ResponseHasProperty(okResult.Value, "AuthSub"),
            "AuthSub SHOULD be included in /me response under LocalAuth — it is the username the user typed at the login form, not a topology leak.");
    }

    [Fact]
    public async Task UpdateMe_ProxyAuthMode_OmitsAuthSubFromResponse()
    {
        using var db = TestDbContextFactory.Create();
        var config = CreateProxyAuthConfig();
        var dataBuilder = new TestDataBuilder(db);
        await dataBuilder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(IdentityPubkey: "new-pubkey-456");

        var result = await controller.UpdateMe(request);

        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.False(
            ResponseHasProperty(okResult.Value, "AuthSub"),
            "AuthSub MUST be omitted from PUT /me response when Auth:ProxyAuthEnabled=true.");
        Assert.True(ResponseHasProperty(okResult.Value, "IdentityPubkey"));
    }

    [Fact]
    public async Task UpdateMe_LocalAuthMode_IncludesAuthSubInResponse()
    {
        using var db = TestDbContextFactory.Create();
        var config = CreateLocalAuthConfig();
        var dataBuilder = new TestDataBuilder(db);
        await dataBuilder.CreateUserAsync(TestAuthSub);

        var controller = new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(TestAuthSub)
            }
        };

        var request = new UpdateUserRequest(IdentityPubkey: "new-pubkey-789");

        var result = await controller.UpdateMe(request);

        var okResult = Assert.IsType<OkObjectResult>(result);
        Assert.True(
            ResponseHasProperty(okResult.Value, "AuthSub"),
            "AuthSub SHOULD be included in PUT /me response under LocalAuth.");
    }
}
