using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Crypto;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Auth;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Tests.Helpers;
using NSubstitute;
using NSec.Cryptography;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;
using Mosaic.Backend.Services;


namespace Mosaic.Backend.Tests.Controllers;

public class AuthControllerTests
{
    private static readonly Lazy<RustCoreHost> RustHost = new(() => new RustCoreHost(NullLogger<RustCoreHost>.Instance));

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
        bool isDevelopment = false,
        TimeProvider? timeProvider = null,
        MosaicMetrics? metrics = null)
    {
        config ??= CreateConfig();
        var logger = Substitute.For<ILogger<AuthController>>();
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns(isDevelopment ? "Development" : "Production");
        var cache = new MemoryCache(new MemoryCacheOptions());

        var httpContext = new DefaultHttpContext();
        httpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(remoteIp ?? "127.0.0.1");

        return new AuthController(db, config, logger, env, cache, RustHost.Value, Mosaic.Backend.Security.KdfPolicy.ForTesting(), auditLog: null, timeProvider: timeProvider ?? TimeProvider.System, metrics: metrics)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext
            }
        };
    }

    private static AuthController CreateControllerWithEnvironmentPolicy(
        Data.MosaicDbContext db,
        string environmentName,
        IConfiguration? config = null)
    {
        config ??= CreateConfig();
        var logger = Substitute.For<ILogger<AuthController>>();
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns(environmentName);
        var cache = new MemoryCache(new MemoryCacheOptions());

        var httpContext = new DefaultHttpContext();
        httpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");

        // Use the real environment-derived KdfPolicy so the floor matches
        // production behaviour for the supplied environmentName.
        var policy = new Mosaic.Backend.Security.KdfPolicy(env);

        return new AuthController(db, config, logger, env, cache, RustHost.Value, policy)
        {
            ControllerContext = new ControllerContext { HttpContext = httpContext }
        };
    }

    [Fact]
    public async Task Register_InProductionEnv_RejectsWeakKdf_8MiB_1Iter()
    {
        // security-review-2026-05-20-01: in Production the server MUST
        // refuse to register accounts with 8 MiB / 1 iter Argon2.
        using var db = TestDbContextFactory.Create();
        var controller = CreateControllerWithEnvironmentPolicy(db, "Production");

        var result = await controller.Register(new AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            KdfMemoryKib: 8_192,
            KdfIterations: 1,
            KdfParallelism: 1,
            KdfAlgVersion: 0x13
        ));

        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("Invalid KDF profile", ProblemDetailsAssertions.GetDetail(badRequest));
        Assert.Empty(db.Users);
    }

    [Fact]
    public async Task Register_InTestingEnv_AcceptsWeakKdf_8MiB_1Iter()
    {
        // The Testing environment intentionally relaxes the floor so the
        // weak-kdf E2E pool (VITE_E2E_WEAK_KEYS=true) can register users
        // in milliseconds.
        using var db = TestDbContextFactory.Create();
        var controller = CreateControllerWithEnvironmentPolicy(db, "Testing");

        var result = await controller.Register(new AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            KdfMemoryKib: 8_192,
            KdfIterations: 1,
            KdfParallelism: 1,
            KdfAlgVersion: 0x13
        ));

        Assert.IsType<CreatedResult>(result);
        var user = Assert.Single(db.Users);
        Assert.Equal(8_192, user.KdfMemoryKib);
        Assert.Equal(1, user.KdfIterations);
    }

    [Fact]
    public async Task Register_InProductionEnv_AcceptsDefaultKdf_64MiB_3Iter()
    {
        using var db = TestDbContextFactory.Create();
        var controller = CreateControllerWithEnvironmentPolicy(db, "Production");

        var result = await controller.Register(new AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            KdfMemoryKib: 65_536,
            KdfIterations: 3,
            KdfParallelism: 1,
            KdfAlgVersion: 0x13
        ));

        Assert.IsType<CreatedResult>(result);
        var user = Assert.Single(db.Users);
        Assert.Equal(65_536, user.KdfMemoryKib);
        Assert.Equal(3, user.KdfIterations);
    }

    private static (byte[] publicKey, byte[] secretKey) GenerateEd25519Keypair()
    {
        var algorithm = SignatureAlgorithm.Ed25519;
        using var key = Key.Create(algorithm, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        return (key.Export(KeyBlobFormat.RawPublicKey), key.Export(KeyBlobFormat.RawPrivateKey));
    }

    private static string SignChallenge(byte[] challenge, string username, byte[] secretKey, long? timestamp = null)
    {
        var message = AuthChallengeTranscriptBuilder.BuildTranscript(username, challenge, timestamp);

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
        var result = await controller.InitAuth(new AuthInitRequest("alice"));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AuthInitResponse>(okResult.Value);
        Assert.NotNull(response.Challenge);
        Assert.NotNull(response.UserSalt);
        Assert.NotEqual(Guid.Empty, response.ChallengeId);
    }

    [Fact]
    public async Task AuthInit_WhenLocalAuthDisabled_ReturnsProblemDetailsNotFound()
    {
        // Arrange: explicit ProxyAuth (LocalAuth disabled)
        using var db = TestDbContextFactory.Create();
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "true"
            })
            .Build();
        var controller = CreateController(db, config);

        // Act
        var result = await controller.InitAuth(new AuthInitRequest("alice"));

        // Assert: RFC7807 ProblemDetails 404, not a plain {error:"Not found"} body
        var notFound = ProblemDetailsAssertions.AssertNotFound(result);
        var problem = Assert.IsType<ProblemDetails>(notFound.Value);
        Assert.Equal(404, problem.Status);
        Assert.Equal("Local authentication disabled", problem.Title);
        Assert.Contains("local authentication is enabled", problem.Detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task InitAuth_RejectsBadUsername()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result = await controller.InitAuth(new AuthInitRequest(""));

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
        var result = await controller.InitAuth(new AuthInitRequest("user with spaces!"));

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
        var result = await controller.InitAuth(new AuthInitRequest("existing-user"));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AuthInitResponse>(okResult.Value);
        Assert.Equal(Convert.ToBase64String(userSalt), response.UserSalt);
    }

    [Fact]
    public async Task InitAuth_ReturnsFakeSaltForNonexistentUser()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result1 = await controller.InitAuth(new AuthInitRequest("nonexistent"));
        var result2 = await controller.InitAuth(new AuthInitRequest("nonexistent"));

        // Assert - fake salt should be deterministic
        var response1 = Assert.IsType<AuthInitResponse>(Assert.IsType<OkObjectResult>(result1).Value);
        var response2 = Assert.IsType<AuthInitResponse>(Assert.IsType<OkObjectResult>(result2).Value);
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
        var initResult = await controller.InitAuth(new AuthInitRequest("alice"));
        var initResponse = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        var challenge = Convert.FromBase64String(initResponse.Challenge);
        var signature = SignChallenge(challenge, "alice", secretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
            "alice",
            initResponse.ChallengeId,
            signature
        ));

        // Assert
        var okResult = Assert.IsType<OkObjectResult>(result);
        var response = Assert.IsType<AuthVerifyResponse>(okResult.Value);
        Assert.True(response.Success);
        Assert.Equal(user.Id, response.UserId);
        Assert.Equal(Convert.ToBase64String(accountSalt), response.AccountSalt);
    }

    [Fact]
    public async Task VerifyAuth_AllowsOnlyOneConcurrentClaimForSameChallenge()
    {
        var connectionString = $"Data Source=file:{Guid.NewGuid():N}?mode=memory&cache=shared";
        await using var rootConnection = new SqliteConnection(connectionString);
        await rootConnection.OpenAsync();

        var options = new DbContextOptionsBuilder<Data.MosaicDbContext>()
            .UseSqlite(connectionString)
            .Options;

        var (publicKey, secretKey) = GenerateEd25519Keypair();
        var challenge = RandomNumberGenerator.GetBytes(32);
        var challengeId = Guid.CreateVersion7();

        await using (var setupDb = new Data.MosaicDbContext(options))
        {
            await setupDb.Database.EnsureCreatedAsync();
            setupDb.Users.Add(new User
            {
                Id = Guid.CreateVersion7(),
                AuthSub = "alice-concurrent",
                IdentityPubkey = "identity-pubkey",
                AuthPubkey = Convert.ToBase64String(publicKey),
                UserSalt = RandomNumberGenerator.GetBytes(16),
                AccountSalt = RandomNumberGenerator.GetBytes(16)
            });
            setupDb.AuthChallenges.Add(new AuthChallenge
            {
                Id = challengeId,
                Username = "alice-concurrent",
                Challenge = challenge,
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddMinutes(1)
            });
            await setupDb.SaveChangesAsync();
        }

        var signature = SignChallenge(challenge, "alice-concurrent", secretKey);

        async Task<IActionResult> VerifyWithNewContextAsync()
        {
            await using var db = new Data.MosaicDbContext(options);
            var controller = CreateController(db);
            return await controller.VerifyAuth(new AuthVerifyRequest(
                "alice-concurrent",
                challengeId,
                signature));
        }

        var results = await Task.WhenAll(
            VerifyWithNewContextAsync(),
            VerifyWithNewContextAsync());

        Assert.Equal(1, results.Count(result => result is OkObjectResult));
        Assert.Equal(1, results.Count(result => result is ObjectResult objectResult
            && objectResult.StatusCode == StatusCodes.Status401Unauthorized));
    }

    [Fact]
    public async Task InitAuth_ReturnsPinnedKdfProfileForExistingUser()
    {
        using var db = TestDbContextFactory.Create();
        var userSalt = RandomNumberGenerator.GetBytes(16);
        db.Users.Add(new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "mobile-user",
            IdentityPubkey = "identity-pubkey",
            AuthPubkey = Convert.ToBase64String(GenerateEd25519Keypair().publicKey),
            UserSalt = userSalt,
            KdfMemoryKib = 32768,
            KdfIterations = 4,
            KdfParallelism = 1,
            KdfAlgVersion = 0x13
        });
        await db.SaveChangesAsync();

        var controller = CreateController(db);

        var result = await controller.InitAuth(new AuthInitRequest("mobile-user"));

        var response = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(Convert.ToBase64String(userSalt), response.UserSalt);
        Assert.Equal(32768, response.KdfMemoryKib);
        Assert.Equal(4, response.KdfIterations);
        Assert.Equal(1, response.KdfParallelism);
        Assert.Equal(0x13, response.KdfAlgVersion);
    }

    [Fact]
    public async Task VerifyAuth_ReturnsPinnedKdfProfileAfterSuccessfulLogin()
    {
        using var db = TestDbContextFactory.Create();
        var (publicKey, secretKey) = GenerateEd25519Keypair();
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice-mobile",
            IdentityPubkey = "identity-pubkey",
            AuthPubkey = Convert.ToBase64String(publicKey),
            UserSalt = RandomNumberGenerator.GetBytes(16),
            AccountSalt = RandomNumberGenerator.GetBytes(16),
            KdfMemoryKib = 32768,
            KdfIterations = 4,
            KdfParallelism = 1,
            KdfAlgVersion = 0x13
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        var initResult = await controller.InitAuth(new AuthInitRequest(user.AuthSub));
        var initResponse = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);
        var signature = SignChallenge(
            Convert.FromBase64String(initResponse.Challenge),
            user.AuthSub,
            secretKey);

        var result = await controller.VerifyAuth(new AuthVerifyRequest(
            user.AuthSub,
            initResponse.ChallengeId,
            signature));

        var response = Assert.IsType<AuthVerifyResponse>(
            Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(32768, response.KdfMemoryKib);
        Assert.Equal(4, response.KdfIterations);
        Assert.Equal(1, response.KdfParallelism);
        Assert.Equal(0x13, response.KdfAlgVersion);
    }

    [Fact]
    public async Task VerifyAuth_RejectsInvalidUsernameFormatBeforeChallengeLookup()
    {
        // Arrange
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        // Act
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
            "café",
            Guid.CreateVersion7(),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(64))
        ));

        // Assert
        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("Invalid username format", ProblemDetailsAssertions.GetDetail(badRequest));
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
        var initResult = await controller.InitAuth(new AuthInitRequest("alice"));
        var initResponse = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        var challenge = Convert.FromBase64String(initResponse.Challenge);
        var wrongSignature = SignChallenge(challenge, "alice", wrongSecretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
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
        var initResult = await controller.InitAuth(new AuthInitRequest("nonexistent"));
        var initResponse = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        // Act
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
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
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
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
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
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
        var result = await controller.Register(new AuthRegisterRequest(
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

    [Theory]
    [InlineData(65536, 3, 1, 0x13)]
    [InlineData(32768, 4, 1, 0x13)]
    public async Task Register_StoresClientPinnedKdfProfile(int memoryKib, int iterations, int parallelism, byte algVersion)
    {
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        var result = await controller.Register(new AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            KdfMemoryKib: memoryKib,
            KdfIterations: iterations,
            KdfParallelism: parallelism,
            KdfAlgVersion: algVersion
        ));

        Assert.IsType<CreatedResult>(result);
        var user = Assert.Single(db.Users);
        Assert.Equal(memoryKib, user.KdfMemoryKib);
        Assert.Equal(iterations, user.KdfIterations);
        Assert.Equal(parallelism, user.KdfParallelism);
        Assert.Equal(algVersion, user.KdfAlgVersion);
    }

    [Theory]
    [InlineData(0, 3, 1, 0x13)]
    [InlineData(65536, 0, 1, 0x13)]
    [InlineData(65536, 3, 0, 0x13)]
    [InlineData(65536, 3, 1, 0x10)]
    public async Task Register_RejectsInvalidKdfProfile(int memoryKib, int iterations, int parallelism, byte algVersion)
    {
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        var result = await controller.Register(new AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            KdfMemoryKib: memoryKib,
            KdfIterations: iterations,
            KdfParallelism: parallelism,
            KdfAlgVersion: algVersion
        ));

        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("Invalid KDF profile", ProblemDetailsAssertions.GetDetail(badRequest));
    }

    [Fact]
    public async Task Register_RejectsKdfProfileAboveResourceCeiling()
    {
        using var db = TestDbContextFactory.Create();
        var controller = CreateController(db);

        var result = await controller.Register(new AuthRegisterRequest(
            "newuser",
            "auth-pubkey-base64",
            "identity-pubkey-base64",
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            KdfMemoryKib: 9_999_999_999L,
            KdfIterations: 3,
            KdfParallelism: 1,
            KdfAlgVersion: 0x13
        ));

        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("Invalid KDF profile", ProblemDetailsAssertions.GetDetail(badRequest));
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
        var result = await controller.Register(new AuthRegisterRequest(
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
        var result = await controller.Register(new AuthRegisterRequest(
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
        // No AuthSub in HttpContext.Items â†’ unauthenticated

        var userSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var accountSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

        // Act
        var result = await controller.Register(new AuthRegisterRequest(
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
        var result = await controller.Register(new AuthRegisterRequest(
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
        var result = await controller.Register(new AuthRegisterRequest(
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

    // ---------- v1.0.1 s25 — RecordAuthFailure metric wiring ----------

    [Fact]
    public async Task VerifyAuth_InvalidSignature_IncrementsAuthFailureMetric()
    {
        using var db = TestDbContextFactory.Create();
        var (publicKey, _) = GenerateEd25519Keypair();
        var (_, wrongSecretKey) = GenerateEd25519Keypair();

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

        using var metrics = new MosaicMetrics();
        var before = metrics.AuthFailuresTotalValue;

        var controller = CreateController(db, metrics: metrics);

        var initResult = await controller.InitAuth(new AuthInitRequest("alice"));
        var initResponse = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        var challenge = Convert.FromBase64String(initResponse.Challenge);
        var wrongSignature = SignChallenge(challenge, "alice", wrongSecretKey);

        // Act
        var result = await controller.VerifyAuth(new AuthVerifyRequest(
            "alice",
            initResponse.ChallengeId,
            wrongSignature
        ));

        // Assert — rejected AND counter incremented exactly once
        ProblemDetailsAssertions.AssertUnauthorized(result);
        Assert.Equal(before + 1, metrics.AuthFailuresTotalValue);
    }

    [Fact]
    public async Task VerifyAuth_ValidSignature_DoesNotIncrementAuthFailureMetric()
    {
        using var db = TestDbContextFactory.Create();
        var (publicKey, secretKey) = GenerateEd25519Keypair();

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

        using var metrics = new MosaicMetrics();
        var before = metrics.AuthFailuresTotalValue;

        var controller = CreateController(db, metrics: metrics);

        var initResult = await controller.InitAuth(new AuthInitRequest("alice"));
        var initResponse = Assert.IsType<AuthInitResponse>(
            Assert.IsType<OkObjectResult>(initResult).Value);

        var challenge = Convert.FromBase64String(initResponse.Challenge);
        var signature = SignChallenge(challenge, "alice", secretKey);

        var result = await controller.VerifyAuth(new AuthVerifyRequest(
            "alice",
            initResponse.ChallengeId,
            signature
        ));

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(before, metrics.AuthFailuresTotalValue);
    }
}
