using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Crypto;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Auth;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using NSec.Cryptography;
using NSubstitute;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

/// <summary>
/// Regression tests for the password-rotation stale-session / SaltVersion race
/// (security-review-2026-05-19-05). Verifies that <see cref="AuthController.RotatePassword"/>:
/// - returns 409 when a concurrent rotation has already advanced SaltVersion, and
/// - returns 401 when the caller's session has been revoked between auth and commit.
///
/// We simulate the concurrent commit by hooking into the first <c>SaveChangesAsync</c>
/// call on the controller's DbContext (the challenge-claim save), which happens
/// AFTER the user is loaded but BEFORE the rotation transaction's reload. The hook
/// mutates user / session state through a separate DbContext bound to the same
/// in-memory database so the reload inside the transaction observes the new state.
/// </summary>
public class PasswordRotationConcurrencyTests
{
    private static readonly Lazy<RustCoreHost> RustHost = new(() =>
        new RustCoreHost(NullLogger<RustCoreHost>.Instance));

    private sealed class SavingChangesHook : ISaveChangesInterceptor
    {
        private readonly Func<Task> _hook;
        private readonly int _fireOnNthSave;
        private int _saveCount;
        private bool _fired;

        public SavingChangesHook(Func<Task> hook, int fireOnNthSave = 2)
        {
            _hook = hook;
            _fireOnNthSave = fireOnNthSave;
        }

        public async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            _saveCount++;
            if (!_fired && _saveCount == _fireOnNthSave)
            {
                _fired = true;
                await _hook();
            }
            return result;
        }

        public InterceptionResult<int> SavingChanges(
            DbContextEventData eventData, InterceptionResult<int> result)
        {
            _saveCount++;
            if (!_fired && _saveCount == _fireOnNthSave)
            {
                _fired = true;
                _hook().GetAwaiter().GetResult();
            }
            return result;
        }
    }

    private static IConfiguration LocalAuthConfig() =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:Mode"] = "LocalAuth",
            })
            .Build();

    private static AuthController CreateController(MosaicDbContext db)
    {
        var logger = Substitute.For<ILogger<AuthController>>();
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns("Production");
        var cache = new MemoryCache(new MemoryCacheOptions());
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");

        return new AuthController(db, LocalAuthConfig(), logger, env, cache, RustHost.Value)
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

    private static string SignTranscript(byte[] challenge, string username, byte[] secret)
    {
        var msg = AuthChallengeTranscriptBuilder.BuildTranscript(username, challenge, null);
        using var key = Key.Import(SignatureAlgorithm.Ed25519, secret, KeyBlobFormat.RawPrivateKey);
        return Convert.ToBase64String(SignatureAlgorithm.Ed25519.Sign(key, msg));
    }

    private sealed record Seeded(
        Guid UserId,
        byte[] CurrentPubkey,
        byte[] CurrentSecret,
        byte[] SessionToken,
        AuthChallenge Challenge);

    private static async Task<Seeded> SeedAsync(MosaicDbContext db)
    {
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
            LastSeenAt = DateTime.UtcNow,
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
        return new Seeded(user.Id, pub, sec, sessionToken, challenge);
    }

    private static PasswordRotationRequest BuildRequest(Seeded s)
    {
        var (newPub, _) = GenerateEd25519();
        return new PasswordRotationRequest(
            ChallengeId: s.Challenge.Id,
            CurrentSignature: SignTranscript(s.Challenge.Challenge, "alice", s.CurrentSecret),
            Timestamp: null,
            NewUserSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAuthPubkey: Convert.ToBase64String(newPub),
            NewWrappedAccountKey: Convert.ToBase64String(RandomNumberGenerator.GetBytes(72)));
    }

    private static void AttachSessionCookie(AuthController c, byte[] token) =>
        c.ControllerContext.HttpContext.Request.Headers["Cookie"] =
            $"mosaic_session={Convert.ToBase64String(token)}";

    /// <summary>
    /// Two rotations race; the slower one observes a bumped SaltVersion at reload
    /// and MUST return 409 instead of overwriting the newer password material.
    /// </summary>
    [Fact]
    public async Task Rotate_Concurrent_LastWinnerNotStale_StaleSaltVersionReturns409()
    {
        var dbName = "rotate-race-saltver-" + Guid.NewGuid();
        using var seedDb = TestDbContextFactory.CreateNamed(dbName);
        var seeded = await SeedAsync(seedDb);

        // Hook fires on the SECOND SaveChangesAsync on the controller's DbContext.
        // The first save happens inside GetCurrentUserIdAsync (LastSeenAt update),
        // the second inside TryClaimAuthChallengeAsync (challenge.IsUsed=true).
        // The second is between the controller's user load (line ~798) and the
        // transaction's reload, which is exactly the race window we want to
        // exercise. From a side context we simulate a concurrent rotation that
        // already advanced SaltVersion.
        var concurrentRotationCommitted = new TaskCompletionSource<bool>();
        Func<Task> bump = async () =>
        {
            using var sideDb = TestDbContextFactory.CreateNamed(dbName);
            var u = await sideDb.Users.FirstAsync(x => x.Id == seeded.UserId);
            u.SaltVersion += 1;
            await sideDb.SaveChangesAsync();
            concurrentRotationCommitted.SetResult(true);
        };

        using var db = TestDbContextFactory.CreateNamed(dbName, new SavingChangesHook(bump));
        var controller = CreateController(db);
        AttachSessionCookie(controller, seeded.SessionToken);

        var req = BuildRequest(seeded);
        var result = await controller.RotatePassword(req);

        Assert.True(concurrentRotationCommitted.Task.IsCompleted,
            "Concurrent rotation hook must have fired before reload.");

        // Expect 409 Conflict from the stale-SaltVersion guard.
        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, problem.StatusCode);

        // The slower rotation MUST NOT have overwritten the winner's state.
        using var verifyDb = TestDbContextFactory.CreateNamed(dbName);
        var finalUser = await verifyDb.Users.FirstAsync(x => x.Id == seeded.UserId);
        Assert.NotEqual(req.NewAuthPubkey, finalUser.AuthPubkey);
        Assert.Equal(Convert.ToBase64String(seeded.CurrentPubkey), finalUser.AuthPubkey);
        // SaltVersion was bumped exactly once (by the concurrent winner), not twice.
        Assert.Equal(2, finalUser.SaltVersion);
    }

    /// <summary>
    /// A concurrent rotation revokes the caller's session between auth and commit.
    /// The rotation MUST return 401 rather than silently revive the revoked session.
    /// </summary>
    [Fact]
    public async Task Rotate_Concurrent_LastWinnerNotStale_SessionRevokedReturns401()
    {
        var dbName = "rotate-race-session-" + Guid.NewGuid();
        using var seedDb = TestDbContextFactory.CreateNamed(dbName);
        var seeded = await SeedAsync(seedDb);
        var sessionHash = SHA256.HashData(seeded.SessionToken);

        // Hook revokes the caller's session via a side context. Critically it
        // does NOT bump SaltVersion — this isolates the session-active recheck
        // from the SaltVersion guard.
        Func<Task> revoke = async () =>
        {
            using var sideDb = TestDbContextFactory.CreateNamed(dbName);
            var session = await sideDb.Sessions.FirstAsync(s => s.TokenHash == sessionHash);
            session.RevokedAt = DateTime.UtcNow;
            await sideDb.SaveChangesAsync();
        };

        using var db = TestDbContextFactory.CreateNamed(dbName, new SavingChangesHook(revoke));
        var controller = CreateController(db);
        AttachSessionCookie(controller, seeded.SessionToken);

        var req = BuildRequest(seeded);
        var result = await controller.RotatePassword(req);

        Assert.IsType<UnauthorizedResult>(result);

        // No credential material was overwritten.
        using var verifyDb = TestDbContextFactory.CreateNamed(dbName);
        var finalUser = await verifyDb.Users.FirstAsync(x => x.Id == seeded.UserId);
        Assert.NotEqual(req.NewAuthPubkey, finalUser.AuthPubkey);
        Assert.Equal(1, finalUser.SaltVersion);
    }
}
