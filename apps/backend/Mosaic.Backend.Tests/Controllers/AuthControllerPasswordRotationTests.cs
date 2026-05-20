using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Crypto;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Auth;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using NSec.Cryptography;
using NSubstitute;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

/// <summary>
/// Tests for <c>POST /api/v1/auth/password-rotation</c> (v1.0.x s38).
/// </summary>
public class AuthControllerPasswordRotationTests
{
    private static readonly Lazy<RustCoreHost> RustHost = new(() =>
        new RustCoreHost(NullLogger<RustCoreHost>.Instance));

    private static IConfiguration LocalAuthConfig() =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:Mode"] = "LocalAuth",
            })
            .Build();

    private static AuthController CreateController(Mosaic.Backend.Data.MosaicDbContext db, IConfiguration? config = null)
    {
        config ??= LocalAuthConfig();
        var logger = Substitute.For<ILogger<AuthController>>();
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns("Production");
        var cache = new MemoryCache(new MemoryCacheOptions());
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");

        return new AuthController(db, config, logger, env, cache, RustHost.Value, Mosaic.Backend.Security.KdfPolicy.ForTesting())
        {
            ControllerContext = new ControllerContext { HttpContext = http }
        };
    }

    private static (byte[] pubkey, byte[] secret) GenerateEd25519()
    {
        using var key = Key.Create(SignatureAlgorithm.Ed25519,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        return (key.Export(KeyBlobFormat.RawPublicKey), key.Export(KeyBlobFormat.RawPrivateKey));
    }

    private static string SignTranscript(byte[] challenge, string username, byte[] secret, long? ts)
    {
        var msg = AuthChallengeTranscriptBuilder.BuildTranscript(username, challenge, ts);
        using var key = Key.Import(SignatureAlgorithm.Ed25519, secret, KeyBlobFormat.RawPrivateKey);
        return Convert.ToBase64String(SignatureAlgorithm.Ed25519.Sign(key, msg));
    }

    private sealed class Fixture
    {
        public required Mosaic.Backend.Data.MosaicDbContext Db;
        public required User User;
        public required byte[] CurrentPubkey;
        public required byte[] CurrentSecret;
        public required byte[] CurrentTokenBytes;
        public required AuthChallenge Challenge;
    }

    private static async Task<Fixture> SetupAsync()
    {
        var db = TestDbContextFactory.Create();
        var (pub, sec) = GenerateEd25519();
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "alice",
            IdentityPubkey = "id-pub",
            AuthPubkey = Convert.ToBase64String(pub),
            UserSalt = RandomNumberGenerator.GetBytes(16),
            WrappedAccountKey = RandomNumberGenerator.GetBytes(72),
            SaltVersion = 1,
        };
        db.Users.Add(user);

        var sessionToken = RandomNumberGenerator.GetBytes(32);
        db.Sessions.Add(new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            TokenHash = SHA256.HashData(sessionToken),
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        });

        var challenge = new AuthChallenge
        {
            Id = Guid.CreateVersion7(),
            Username = "alice",
            Challenge = RandomNumberGenerator.GetBytes(32),
            ExpiresAt = DateTime.UtcNow.AddMinutes(5),
            IsUsed = false,
            CreatedAt = DateTime.UtcNow,
            IpAddress = "127.0.0.1",
        };
        db.AuthChallenges.Add(challenge);

        await db.SaveChangesAsync();
        return new Fixture
        {
            Db = db,
            User = user,
            CurrentPubkey = pub,
            CurrentSecret = sec,
            CurrentTokenBytes = sessionToken,
            Challenge = challenge,
        };
    }

    private static PasswordRotationRequest BuildRequest(Fixture f, byte[]? newPub = null, long? ts = null)
    {
        var pub = newPub ?? GenerateEd25519().pubkey;
        var sig = SignTranscript(f.Challenge.Challenge, f.User.AuthSub, f.CurrentSecret, ts);
        return new PasswordRotationRequest(
            ChallengeId: f.Challenge.Id,
            CurrentSignature: sig,
            Timestamp: ts,
            NewUserSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAccountSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAuthPubkey: Convert.ToBase64String(pub),
            NewWrappedAccountKey: Convert.ToBase64String(RandomNumberGenerator.GetBytes(72)));
    }

    private static void AttachSessionCookie(AuthController c, byte[] token)
    {
        c.ControllerContext.HttpContext.Request.Headers["Cookie"] =
            $"mosaic_session={Convert.ToBase64String(token)}";
    }

    [Fact]
    public async Task RotatePassword_ValidSignature_RotatesAtomically()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var req = BuildRequest(f);
        var result = await controller.RotatePassword(req);

        var ok = Assert.IsType<OkObjectResult>(result);
        var resp = Assert.IsType<PasswordRotationResponse>(ok.Value);
        Assert.Equal(2, resp.SaltVersion);
        Assert.Equal(0, resp.RevokedSessionCount);

        var refreshed = db.Users.Single();
        Assert.Equal(req.NewAuthPubkey, refreshed.AuthPubkey);
        Assert.Equal(2, refreshed.SaltVersion);
        Assert.Equal(Convert.FromBase64String(req.NewUserSalt), refreshed.UserSalt);
        // v1.0.x validation-final-gate-auth-f: AccountSalt MUST also rotate.
        // Without this, the next login derives L1 from a stale account salt
        // and the freshly-rewrapped WrappedAccountKey fails to unwrap.
        Assert.Equal(Convert.FromBase64String(req.NewAccountSalt), refreshed.AccountSalt);
        Assert.Equal(Convert.FromBase64String(req.NewWrappedAccountKey), refreshed.WrappedAccountKey);
    }

    /// <summary>
    /// Regression for v1.0.x validation-final-gate-auth-f. Reproduces the
    /// "password change succeeds but subsequent login fails" symptom by
    /// verifying that the rotation transaction:
    ///   1. Persists NewAccountSalt onto user.AccountSalt (so the next
    ///      login derives the same L1 that the client used to rewrap L2).
    ///   2. Leaves the row coherent: AccountSalt != prior AccountSalt, and
    ///      all four rotated fields move together.
    /// </summary>
    [Fact]
    public async Task RotatePassword_PersistsNewAccountSalt_SoNextLoginCanUnwrap()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var originalAccountSalt = RandomNumberGenerator.GetBytes(16);
        f.User.AccountSalt = originalAccountSalt;
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var newAccountSalt = RandomNumberGenerator.GetBytes(16);
        var newUserSalt = RandomNumberGenerator.GetBytes(16);
        var newWrapped = RandomNumberGenerator.GetBytes(72);
        var (newPub, _) = GenerateEd25519();
        var sig = SignTranscript(f.Challenge.Challenge, f.User.AuthSub, f.CurrentSecret, null);
        var req = new PasswordRotationRequest(
            ChallengeId: f.Challenge.Id,
            CurrentSignature: sig,
            Timestamp: null,
            NewUserSalt: Convert.ToBase64String(newUserSalt),
            NewAccountSalt: Convert.ToBase64String(newAccountSalt),
            NewAuthPubkey: Convert.ToBase64String(newPub),
            NewWrappedAccountKey: Convert.ToBase64String(newWrapped));

        var result = await controller.RotatePassword(req);
        Assert.IsType<OkObjectResult>(result);

        var refreshed = db.Users.Single();
        Assert.Equal(newAccountSalt, refreshed.AccountSalt);
        Assert.NotEqual(originalAccountSalt, refreshed.AccountSalt);
        Assert.Equal(newUserSalt, refreshed.UserSalt);
        Assert.Equal(newWrapped, refreshed.WrappedAccountKey);
        Assert.Equal(Convert.ToBase64String(newPub), refreshed.AuthPubkey);
    }

    [Fact]
    public async Task RotatePassword_WrongAccountSaltLength_Returns400_AndDoesNotMutate()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var sig = SignTranscript(f.Challenge.Challenge, f.User.AuthSub, f.CurrentSecret, null);
        var (newPub, _) = GenerateEd25519();
        var req = new PasswordRotationRequest(
            ChallengeId: f.Challenge.Id,
            CurrentSignature: sig,
            Timestamp: null,
            NewUserSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAccountSalt: Convert.ToBase64String(new byte[8]), // wrong length
            NewAuthPubkey: Convert.ToBase64String(newPub),
            NewWrappedAccountKey: Convert.ToBase64String(RandomNumberGenerator.GetBytes(72)));

        var result = await controller.RotatePassword(req);
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, obj.StatusCode);

        var refreshed = db.Users.Single();
        Assert.Equal(1, refreshed.SaltVersion);
        Assert.Equal(Convert.ToBase64String(f.CurrentPubkey), refreshed.AuthPubkey);
    }

    [Fact]
    public async Task RotatePassword_RevokesOtherSessionsButNotCurrent()
    {
        var f = await SetupAsync();
        using var db = f.Db;

        // Add 2 other active sessions for the same user.
        for (int i = 0; i < 2; i++)
        {
            db.Sessions.Add(new Session
            {
                Id = Guid.CreateVersion7(),
                UserId = f.User.Id,
                TokenHash = SHA256.HashData(RandomNumberGenerator.GetBytes(32)),
                ExpiresAt = DateTime.UtcNow.AddDays(7),
            });
        }
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var result = await controller.RotatePassword(BuildRequest(f));

        var ok = Assert.IsType<OkObjectResult>(result);
        var resp = Assert.IsType<PasswordRotationResponse>(ok.Value);
        Assert.Equal(2, resp.RevokedSessionCount);

        var currentHash = SHA256.HashData(f.CurrentTokenBytes);
        var current = db.Sessions.Single(s => s.TokenHash.SequenceEqual(currentHash));
        Assert.Null(current.RevokedAt);
        var others = db.Sessions.Where(s => !s.TokenHash.SequenceEqual(currentHash)).ToList();
        Assert.All(others, s => Assert.NotNull(s.RevokedAt));
    }

    [Fact]
    public async Task RotatePassword_InvalidSignature_Returns401_AndDoesNotMutate()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        // Sign with the WRONG key.
        var (_, wrongSecret) = GenerateEd25519();
        var badSig = SignTranscript(f.Challenge.Challenge, f.User.AuthSub, wrongSecret, null);
        var (newPub, _) = GenerateEd25519();
        var req = new PasswordRotationRequest(
            ChallengeId: f.Challenge.Id,
            CurrentSignature: badSig,
            Timestamp: null,
            NewUserSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAccountSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAuthPubkey: Convert.ToBase64String(newPub),
            NewWrappedAccountKey: Convert.ToBase64String(RandomNumberGenerator.GetBytes(72)));

        var result = await controller.RotatePassword(req);

        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status401Unauthorized, obj.StatusCode);

        var refreshed = db.Users.Single();
        Assert.Equal(1, refreshed.SaltVersion);
        Assert.Equal(Convert.ToBase64String(f.CurrentPubkey), refreshed.AuthPubkey);
    }

    [Fact]
    public async Task RotatePassword_ChallengeAlreadyUsed_Returns401()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        f.Challenge.IsUsed = true;
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var result = await controller.RotatePassword(BuildRequest(f));
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status401Unauthorized, obj.StatusCode);
    }

    [Fact]
    public async Task RotatePassword_ExpiredChallenge_Returns401()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        f.Challenge.ExpiresAt = DateTime.UtcNow.AddMinutes(-1);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var result = await controller.RotatePassword(BuildRequest(f));
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status401Unauthorized, obj.StatusCode);
    }

    [Fact]
    public async Task RotatePassword_NoSession_Returns401()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var controller = CreateController(db);
        // No cookie attached.

        var result = await controller.RotatePassword(BuildRequest(f));
        Assert.IsAssignableFrom<UnauthorizedResult>(result);
    }

    [Fact]
    public async Task RotatePassword_ProxyAuthMode_Returns404()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Auth:Mode"] = "ProxyAuth" })
            .Build();
        var controller = CreateController(db, config);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var result = await controller.RotatePassword(BuildRequest(f));
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status404NotFound, obj.StatusCode);
    }

    [Fact]
    public async Task RotatePassword_InvalidBase64_Returns400()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var req = new PasswordRotationRequest(
            ChallengeId: f.Challenge.Id,
            CurrentSignature: "not-base64!@#",
            Timestamp: null,
            NewUserSalt: "AAAA",
            NewAccountSalt: "AAAA",
            NewAuthPubkey: "AAAA",
            NewWrappedAccountKey: "AAAA");

        var result = await controller.RotatePassword(req);
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, obj.StatusCode);
    }

    [Fact]
    public async Task RotatePassword_WrongSaltLength_Returns400()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var sig = SignTranscript(f.Challenge.Challenge, f.User.AuthSub, f.CurrentSecret, null);
        var (newPub, _) = GenerateEd25519();
        var req = new PasswordRotationRequest(
            ChallengeId: f.Challenge.Id,
            CurrentSignature: sig,
            Timestamp: null,
            NewUserSalt: Convert.ToBase64String(new byte[8]),  // wrong length
            NewAccountSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAuthPubkey: Convert.ToBase64String(newPub),
            NewWrappedAccountKey: Convert.ToBase64String(RandomNumberGenerator.GetBytes(72)));

        var result = await controller.RotatePassword(req);
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, obj.StatusCode);
    }

    [Fact]
    public async Task RotatePassword_SaltVersionBumpsMonotonically()
    {
        var f = await SetupAsync();
        using var db = f.Db;
        f.User.SaltVersion = 7;
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        AttachSessionCookie(controller, f.CurrentTokenBytes);

        var result = await controller.RotatePassword(BuildRequest(f));
        var ok = Assert.IsType<OkObjectResult>(result);
        var resp = Assert.IsType<PasswordRotationResponse>(ok.Value);
        Assert.Equal(8, resp.SaltVersion);
    }
}
