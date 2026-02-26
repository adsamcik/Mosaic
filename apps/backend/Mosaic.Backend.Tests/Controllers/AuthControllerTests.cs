using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using NSubstitute;
using NSec.Cryptography;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class AuthControllerTests
{
    private static IConfiguration CreateConfig(string? serverSecret = null)
    {
        var configValues = new Dictionary<string, string?>
        {
            ["Auth:Mode"] = "LocalAuth",
            ["Auth:ServerSecret"] = serverSecret
        };
        return new ConfigurationBuilder()
            .AddInMemoryCollection(configValues)
            .Build();
    }

    private static AuthController CreateController(
        Data.MosaicDbContext db,
        IConfiguration? config = null,
        string? remoteIp = "127.0.0.1",
        bool isDevelopment = false)
    {
        config ??= CreateConfig();
        var logger = Substitute.For<ILogger<AuthController>>();
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns(isDevelopment ? "Development" : "Production");
        var cache = new MemoryCache(new MemoryCacheOptions());

        var httpContext = new DefaultHttpContext();
        httpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(remoteIp ?? "127.0.0.1");

        return new AuthController(db, config, logger, env, cache)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext
            }
        };
    }

    private static (byte[] publicKey, byte[] secretKey) GenerateEd25519Keypair()
    {
        var algorithm = SignatureAlgorithm.Ed25519;
        using var key = Key.Create(algorithm, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        return (key.Export(KeyBlobFormat.RawPublicKey), key.Export(KeyBlobFormat.RawPrivateKey));
    }

    private static string SignChallenge(byte[] challenge, string username, byte[] secretKey, long? timestamp = null)
    {
        // Must match the format in AuthController and TypeScript implementation
        const string context = "Mosaic_Auth_Challenge_v1";
        var contextBytes = System.Text.Encoding.UTF8.GetBytes(context);
        var usernameBytes = System.Text.Encoding.UTF8.GetBytes(username);
        var usernameLenBytes = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(usernameLenBytes, (uint)usernameBytes.Length);

        byte[] message;
        if (timestamp.HasValue)
        {
            var timestampBytes = new byte[8];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt64BigEndian(timestampBytes, (ulong)timestamp.Value);
            message = contextBytes
                .Concat(usernameLenBytes)
                .Concat(usernameBytes)
                .Concat(timestampBytes)
                .Concat(challenge)
                .ToArray();
        }
        else
        {
            message = contextBytes
                .Concat(usernameLenBytes)
                .Concat(usernameBytes)
                .Concat(challenge)
                .ToArray();
        }

        var algorithm = SignatureAlgorithm.Ed25519;
        using var key = Key.Import(algorithm, secretKey, KeyBlobFormat.RawPrivateKey);
        var signature = algorithm.Sign(key, message);
        return Convert.ToBase64String(signature);
    }

    [Fact]
    public async Task InitAuth_ReturnsChallenge()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result = await controller.InitAuth(new AuthController.AuthInitRequest("alice"));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AuthController.AuthInitResponse>(okResult.Value);
        Assert.NotNull(response.Challenge);
        Assert.NotNull(response.UserSalt);
        Assert.NotEqual(Guid.Empty, response.ChallengeId);
    }

    [Fact]
    public async Task InitAuth_RejectsBadUsername()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result = await controller.InitAuth(new AuthController.AuthInitRequest(""));

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("required", ProblemDetailsAssertions.GetDetail(badRequest), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task InitAuth_RejectsInvalidUsernameFormat()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result = await controller.InitAuth(new AuthController.AuthInitRequest("user with spaces!"));

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("Invalid username format", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task InitAuth_ReturnsRealSaltForExistingUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var userSalt = RandomNumberGenerator.GetBytes(16);
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "existing-user",
            IdentityPubkey = "test-pubkey",
            UserSalt = userSalt
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        // Act
        var result = await controller.InitAuth(new AuthController.AuthInitRequest("existing-user"));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AuthController.AuthInitResponse>(okResult.Value);
        Assert.Equal(Convert.ToBase64String(userSalt), response.UserSalt);
    }

    [Fact]
    public async Task InitAuth_ReturnsFakeSaltForNonexistentUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result1 = await controller.InitAuth(new AuthController.AuthInitRequest("nonexistent"));
        var result2 = await controller.InitAuth(new AuthController.AuthInitRequest("nonexistent"));

        // Assert - fake salt should be deterministic
        var response1 = Assert.IsType<AuthController.AuthInitResponse>(Assert.IsType<OkObjectResult>(result1).Value);
        var response2 = Assert.IsType<AuthController.AuthInitResponse>(Assert.IsType<OkObjectResult>(result2).Value);
        Assert.Equal(response1.UserSalt, response2.UserSalt);
    }

    [Fact]
    public async Task VerifyAuth_SucceedsWithValidSignature()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var (publicKey, secretKey) = GenerateEd25519Keypair();

        var userSalt = RandomNumberGenerator.GetBytes(16);
        var accountSalt = RandomNumberGenerator.GetBytes(16);
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "identity-pubkey",
            AuthPubkey = Convert.ToBase64String(publicKey),
            UserSalt = userSalt,
            AccountSalt = accountSalt
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        // Get challenge
        var initResult = await controller.InitAuth(new AuthController.AuthInitRequest("alice"));
        var initResponse = Assert.IsType<AuthController.AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        var challenge = Convert.FromBase64String(initResponse.Challenge);
        var signature = SignChallenge(challenge, "alice", secretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthController.AuthVerifyRequest(
            "alice",
            initResponse.ChallengeId,
            signature
        ));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AuthController.AuthVerifyResponse>(okResult.Value);
        Assert.True(response.Success);
        Assert.Equal(user.Id, response.UserId);
        Assert.Equal(Convert.ToBase64String(accountSalt), response.AccountSalt);
    }

    [Fact]
    public async Task VerifyAuth_FailsWithWrongSignature()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var (publicKey, _) = GenerateEd25519Keypair();
        var (_, wrongSecretKey) = GenerateEd25519Keypair(); // Different keypair

        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "identity-pubkey",
            AuthPubkey = Convert.ToBase64String(publicKey),
            UserSalt = RandomNumberGenerator.GetBytes(16),
            AccountSalt = RandomNumberGenerator.GetBytes(16)
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        // Get challenge
        var initResult = await controller.InitAuth(new AuthController.AuthInitRequest("alice"));
        var initResponse = Assert.IsType<AuthController.AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        var challenge = Convert.FromBase64String(initResponse.Challenge);
        var wrongSignature = SignChallenge(challenge, "alice", wrongSecretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthController.AuthVerifyRequest(
            "alice",
            initResponse.ChallengeId,
            wrongSignature
        ));

        // Assert
        var unauthorized = ProblemDetailsAssertions.AssertUnauthorized(result);
        Assert.Contains("Invalid credentials", ProblemDetailsAssertions.GetDetail(unauthorized));
    }

    [Fact]
    public async Task VerifyAuth_FailsForNonexistentUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Get challenge (will return fake salt)
        var initResult = await controller.InitAuth(new AuthController.AuthInitRequest("nonexistent"));
        var initResponse = Assert.IsType<AuthController.AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        // Act
        var result = await controller.VerifyAuth(new AuthController.AuthVerifyRequest(
            "nonexistent",
            initResponse.ChallengeId,
            "fake-signature"
        ));

        // Assert
        var unauthorized = ProblemDetailsAssertions.AssertUnauthorized(result);
        Assert.Contains("Invalid credentials", ProblemDetailsAssertions.GetDetail(unauthorized));
    }

    [Fact]
    public async Task VerifyAuth_FailsWithExpiredChallenge()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var (publicKey, secretKey) = GenerateEd25519Keypair();

        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "identity-pubkey",
            AuthPubkey = Convert.ToBase64String(publicKey),
            UserSalt = RandomNumberGenerator.GetBytes(16)
        };
        db.Users.Add(user);

        // Create an already-expired challenge
        var challenge = new AuthChallenge
        {
            Id = Guid.CreateVersion7(),
            Username = "alice",
            Challenge = RandomNumberGenerator.GetBytes(32),
            CreatedAt = DateTime.UtcNow.AddMinutes(-5),
            ExpiresAt = DateTime.UtcNow.AddMinutes(-4) // Expired
        };
        db.AuthChallenges.Add(challenge);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        var signature = SignChallenge(challenge.Challenge, "alice", secretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthController.AuthVerifyRequest(
            "alice",
            challenge.Id,
            signature
        ));

        // Assert
        var unauthorized = ProblemDetailsAssertions.AssertUnauthorized(result);
        Assert.Contains("expired", ProblemDetailsAssertions.GetDetail(unauthorized), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task VerifyAuth_FailsWithUsedChallenge()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var (publicKey, secretKey) = GenerateEd25519Keypair();

        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "identity-pubkey",
            AuthPubkey = Convert.ToBase64String(publicKey),
            UserSalt = RandomNumberGenerator.GetBytes(16)
        };
        db.Users.Add(user);

        // Create an already-used challenge
        var challenge = new AuthChallenge
        {
            Id = Guid.CreateVersion7(),
            Username = "alice",
            Challenge = RandomNumberGenerator.GetBytes(32),
            ExpiresAt = DateTime.UtcNow.AddMinutes(1),
            IsUsed = true // Already used
        };
        db.AuthChallenges.Add(challenge);
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        var signature = SignChallenge(challenge.Challenge, "alice", secretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthController.AuthVerifyRequest(
            "alice",
            challenge.Id,
            signature
        ));

        // Assert
        var unauthorized = ProblemDetailsAssertions.AssertUnauthorized(result);
        Assert.Contains("already used", ProblemDetailsAssertions.GetDetail(unauthorized), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Register_CreatesNewUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        var userSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var accountSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

        // Act
        var result = await controller.Register(new AuthController.AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            userSalt,
            accountSalt
        ));

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.Single(db.Users);
        Assert.Equal("newuser", db.Users.First().AuthSub);
    }

    [Fact]
    public async Task Register_RejectsExistingUsername()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var existingUser = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "existing",
            IdentityPubkey = "pubkey",
            IsAdmin = true
        };
        db.Users.Add(existingUser);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        // Simulate authenticated admin (middleware populates HttpContext.Items)
        controller.ControllerContext.HttpContext.Items["AuthSub"] = "existing";

        var userSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var accountSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

        // Act
        var result = await controller.Register(new AuthController.AuthRegisterRequest(
            "existing",
            "auth-pubkey",
            "identity-pubkey",
            userSalt,
            accountSalt
        ));

        // Assert
        var conflictResult = ProblemDetailsAssertions.AssertConflict(result);
        Assert.Contains("already exists", ProblemDetailsAssertions.GetDetail(conflictResult));
    }

    [Fact]
    public async Task Register_RejectsInvalidSaltLength()
    {
        // Arrange - first user (bootstrap), no auth required
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        var shortSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(8)); // Too short

        // Act
        var result = await controller.Register(new AuthController.AuthRegisterRequest(
            "newuser",
            "auth-pubkey",
            "identity-pubkey",
            shortSalt,
            shortSalt
        ));

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("16 bytes", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Register_RejectsUnauthenticatedAfterFirstUser()
    {
        // Arrange - an existing user means this is not the first registration
        using var db = TestDbContextFactory.Create();
        db.Users.Add(new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "admin",
            IdentityPubkey = "pubkey",
            IsAdmin = true
        });
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        // No AuthSub in HttpContext.Items → unauthenticated

        var userSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var accountSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

        // Act
        var result = await controller.Register(new AuthController.AuthRegisterRequest(
            "newuser",
            "auth-pubkey",
            "identity-pubkey",
            userSalt,
            accountSalt
        ));

        // Assert
        var problem = ProblemDetailsAssertions.AssertUnauthorized(result);
        Assert.Contains("Authentication required", ProblemDetailsAssertions.GetDetail(problem));
    }

    [Fact]
    public async Task Register_RejectsNonAdminAfterFirstUser()
    {
        // Arrange - authenticated as a non-admin user
        using var db = TestDbContextFactory.Create();
        db.Users.Add(new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "regularuser",
            IdentityPubkey = "pubkey",
            IsAdmin = false
        });
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        controller.ControllerContext.HttpContext.Items["AuthSub"] = "regularuser";

        var userSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var accountSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

        // Act
        var result = await controller.Register(new AuthController.AuthRegisterRequest(
            "anotheruser",
            "auth-pubkey",
            "identity-pubkey",
            userSalt,
            accountSalt
        ));

        // Assert
        var problem = ProblemDetailsAssertions.AssertForbidden(result);
        Assert.Contains("Admin privileges required", ProblemDetailsAssertions.GetDetail(problem));
    }

    [Fact]
    public async Task Register_AllowsAdminToCreateUserAfterFirstUser()
    {
        // Arrange - authenticated as admin
        using var db = TestDbContextFactory.Create();
        db.Users.Add(new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "admin",
            IdentityPubkey = "pubkey",
            IsAdmin = true
        });
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        controller.ControllerContext.HttpContext.Items["AuthSub"] = "admin";

        var userSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var accountSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

        // Act
        var result = await controller.Register(new AuthController.AuthRegisterRequest(
            "newuser",
            "auth-pubkey",
            "identity-pubkey",
            userSalt,
            accountSalt
        ));

        // Assert
        var createdResult = Assert.IsType<CreatedResult>(result);
        Assert.Equal(2, db.Users.Count());
        Assert.Equal("newuser", db.Users.OrderBy(u => u.CreatedAt).Last().AuthSub);
    }

    [Fact]
    public async Task Logout_RevokesSession()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "pubkey"
        };
        db.Users.Add(user);

        var sessionToken = RandomNumberGenerator.GetBytes(32);
        var session = new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = SHA256.HashData(sessionToken),
            ExpiresAt = DateTime.UtcNow.AddDays(7)
        };
        db.Sessions.Add(session);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        controller.ControllerContext.HttpContext.Request.Headers["Cookie"] =
            $"mosaic_session={Convert.ToBase64String(sessionToken)}";

        // Act
        var result = await controller.Logout();

        // Assert
        Assert.IsType<OkObjectResult>(result);
        var revokedSession = db.Sessions.First();
        Assert.NotNull(revokedSession.RevokedAt);
    }

    [Fact]
    public async Task RevokeOtherSessions_KeepsCurrentSession()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "pubkey"
        };
        db.Users.Add(user);

        var currentToken = RandomNumberGenerator.GetBytes(32);
        var otherToken = RandomNumberGenerator.GetBytes(32);

        var currentSession = new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = SHA256.HashData(currentToken),
            ExpiresAt = DateTime.UtcNow.AddDays(7)
        };
        var otherSession = new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = SHA256.HashData(otherToken),
            ExpiresAt = DateTime.UtcNow.AddDays(7)
        };
        db.Sessions.AddRange(currentSession, otherSession);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        controller.ControllerContext.HttpContext.Request.Headers["Cookie"] =
            $"mosaic_session={Convert.ToBase64String(currentToken)}";

        // Act
        var result = await controller.RevokeOtherSessions();

        // Assert
        Assert.IsType<OkObjectResult>(result);

        // Current session should still be active
        var current = db.Sessions.First(s => s.Id == currentSession.Id);
        Assert.Null(current.RevokedAt);

        // Other session should be revoked
        var other = db.Sessions.First(s => s.Id == otherSession.Id);
        Assert.NotNull(other.RevokedAt);
    }
}
