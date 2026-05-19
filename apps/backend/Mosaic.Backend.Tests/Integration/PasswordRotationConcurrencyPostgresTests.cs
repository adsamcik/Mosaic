extern alias TestcontainersPostgreSql;

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
using NSec.Cryptography;
using NSubstitute;
using TestcontainersPostgreSql::Testcontainers.PostgreSql;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

/// <summary>
/// Real-Postgres concurrency tests for <see cref="AuthController.RotatePassword"/>.
///
/// The InMemory tests in <see cref="PasswordRotationConcurrencyTests"/> cover
/// cheap regressions but EF's InMemory provider silently ignores
/// <c>BeginTransactionAsync(IsolationLevel.Serializable)</c>. These tests
/// exercise the security-critical paths against an actual PostgreSQL server:
///
///   1. <see cref="Rotate_Concurrent_SerializableConflict_OneSucceeds_OtherGets409"/>
///      drives two parallel rotations against the same user with a barrier
///      inside the serializable transaction so they overlap. Postgres SSI
///      detects the conflict; the bounded retry from
///      security-review-2026-05-19-07 either retries the loser to success or
///      surfaces a clean 409 (never a raw 500).
///
///   2. <see cref="Rotate_SessionExpiredBetweenInitAndCommit_Returns401"/>
///      expires the caller's session via a side context between the initial
///      user load and the in-transaction session re-check, proving the F-1
///      fix (security-review-2026-05-19-06) rejects rotations whose session
///      has aged past the absolute/sliding expiry.
///
/// SaltVersion-advance race coverage is provided implicitly by test (1)
/// because the loser's retry observes the winner's bumped SaltVersion and
/// returns 409 — and explicitly by
/// <see cref="PasswordRotationConcurrencyTests.Rotate_Concurrent_LastWinnerNotStale_StaleSaltVersionReturns409"/>.
/// </summary>
public sealed class PasswordRotationConcurrencyPostgresTests
    : IClassFixture<PasswordRotationConcurrencyPostgresTests.PostgresFixture>
{
    private static readonly Lazy<RustCoreHost> RustHost = new(() =>
        new RustCoreHost(NullLogger<RustCoreHost>.Instance));

    private readonly PostgresFixture _fixture;

    public PasswordRotationConcurrencyPostgresTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Rotate_Concurrent_SerializableConflict_OneSucceeds_OtherGets409()
    {
        await _fixture.ResetAsync();

        // Seed: one user with two pre-issued challenges (each rotation consumes one).
        await using (var seedDb = _fixture.CreateContext())
        {
            var (pub, sec) = GenerateEd25519();
            var user = NewUser(pub);
            seedDb.Users.Add(user);
            seedDb.Sessions.Add(NewSession(user.Id, out var token));
            var ch1 = NewChallenge(user.AuthSub);
            var ch2 = NewChallenge(user.AuthSub);
            seedDb.AuthChallenges.AddRange(ch1, ch2);
            await seedDb.SaveChangesAsync();

            _seededUserId = user.Id;
            _seededAuthPubkey = pub;
            _seededAuthSecret = sec;
            _seededSessionToken = token;
            _seededChallenge1 = ch1;
            _seededChallenge2 = ch2;
        }

        // Synchronize at the REAL transactional barrier: fire when each
        // controller has executed BEGIN ISOLATION LEVEL SERIALIZABLE. This
        // guarantees both transactions are open before either reads the user
        // row or attempts its UPDATE, so Postgres SSI must detect the
        // read/write conflict and rotate one of the transactions through the
        // bounded retry loop (security-review-2026-05-19-10). The previous
        // BarrierOnNthSaveInterceptor never fired in practice because the
        // rotation path only executes two SaveChanges calls (challenge claim
        // uses ExecuteUpdateAsync, which bypasses SaveChanges interceptors)
        // — so the test was passing via the stale-SaltVersion 409 path
        // rather than the real Serializable retry path it was meant to
        // verify.
        using var barrier = new Barrier(2);
        var interceptorA = new BarrierOnSerializableTransactionInterceptor(barrier);
        var interceptorB = new BarrierOnSerializableTransactionInterceptor(barrier);

        await using var dbA = _fixture.CreateContext(interceptorA);
        await using var dbB = _fixture.CreateContext(interceptorB);

        var (controllerA, loggerA) = CreateController(dbA, _seededSessionToken);
        var (controllerB, loggerB) = CreateController(dbB, _seededSessionToken);

        var reqA = BuildRequest(_seededChallenge1!, _seededAuthPubkey!, _seededAuthSecret!);
        var reqB = BuildRequest(_seededChallenge2!, _seededAuthPubkey!, _seededAuthSecret!);

        // Race both rotations. One must succeed (200), one must fail with 409.
        // Under no circumstance should either return 500.
        var taskA = Task.Run(() => controllerA.RotatePassword(reqA));
        var taskB = Task.Run(() => controllerB.RotatePassword(reqB));
        var results = await Task.WhenAll(taskA, taskB);

        var statusCodes = results.Select(GetStatusCode).OrderBy(c => c).ToArray();
        Assert.DoesNotContain(StatusCodes.Status500InternalServerError, statusCodes);

        // Exactly one 200 OK and one 409 Conflict.
        Assert.Contains(StatusCodes.Status200OK, statusCodes);
        Assert.Contains(StatusCodes.Status409Conflict, statusCodes);

        // The winner advanced SaltVersion exactly once.
        await using var verifyDb = _fixture.CreateContext();
        var finalUser = await verifyDb.Users.FirstAsync(u => u.Id == _seededUserId);
        Assert.Equal(2, finalUser.SaltVersion);

        // The barrier actually fired on BOTH controllers' Serializable BEGIN.
        // If it didn't, the test would be falling back to the stale-
        // SaltVersion 409 path instead of exercising the retry loop.
        Assert.True(interceptorA.Fired,
            "Controller A's Serializable transaction barrier did not fire — test is not exercising the in-transaction race.");
        Assert.True(interceptorB.Fired,
            "Controller B's Serializable transaction barrier did not fire — test is not exercising the in-transaction race.");

        // The retry-loop warning ("serialization/deadlock conflict ... retrying"
        // or "exhausted ... retries") must have fired on the loser, proving
        // that the controller actually encountered a Postgres SSI conflict
        // (40001) — i.e. the real transactional contention path, not merely
        // the SaltVersion-mismatch shortcut.
        var retryLoggedOnA = LoggerReceivedRotationConflictWarning(loggerA);
        var retryLoggedOnB = LoggerReceivedRotationConflictWarning(loggerB);
        Assert.True(retryLoggedOnA || retryLoggedOnB,
            "Neither controller logged a serialization/deadlock-conflict warning — the test did not exercise the retry path.");
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Rotate_SessionExpiredBetweenInitAndCommit_Returns401()
    {
        await _fixture.ResetAsync();

        Guid userId;
        byte[] pub;
        byte[] sec;
        byte[] token;
        AuthChallenge challenge;
        await using (var seedDb = _fixture.CreateContext())
        {
            (pub, sec) = GenerateEd25519();
            var user = NewUser(pub);
            seedDb.Users.Add(user);
            seedDb.Sessions.Add(NewSession(user.Id, out token));
            challenge = NewChallenge(user.AuthSub);
            seedDb.AuthChallenges.Add(challenge);
            await seedDb.SaveChangesAsync();
            userId = user.Id;
        }

        var sessionHash = SHA256.HashData(token);

        // Hook fires on save #1 (LastSeenAt update inside GetCurrentUserIdAsync,
        // AFTER the session has been validated as active but BEFORE the rotation
        // proceeds to the in-tx re-check). The side context expires the session
        // by pushing ExpiresAt into the past. With the F-1 expiry-check fix, the
        // in-tx re-query must reject this session and the controller must
        // return 401.
        var connStr = _fixture.ConnectionString;
        Func<Task> expireSession = async () =>
        {
            await using var side = NewContext(connStr);
            var session = await side.Sessions.FirstAsync(s => s.TokenHash == sessionHash);
            session.ExpiresAt = DateTime.UtcNow.AddDays(-1);
            await side.SaveChangesAsync();
        };

        var hook = new FireOnceOnNthSaveInterceptor(expireSession, fireOnNthSave: 1);

        await using var db = _fixture.CreateContext(hook);
        var (controller, _) = CreateController(db, token);
        var req = BuildRequest(challenge, pub, sec);

        var result = await controller.RotatePassword(req);

        Assert.IsType<UnauthorizedResult>(result);

        // Credentials must not have rotated.
        await using var verifyDb = _fixture.CreateContext();
        var finalUser = await verifyDb.Users.FirstAsync(u => u.Id == userId);
        Assert.Equal(Convert.ToBase64String(pub), finalUser.AuthPubkey);
        Assert.Equal(1, finalUser.SaltVersion);
    }

    // ---------- Seeding scratch state for the SerializableConflict test ----------
    private Guid _seededUserId;
    private byte[]? _seededAuthPubkey;
    private byte[]? _seededAuthSecret;
    private byte[]? _seededSessionToken;
    private AuthChallenge? _seededChallenge1;
    private AuthChallenge? _seededChallenge2;

    // ---------- Helpers ----------

    private static int GetStatusCode(IActionResult result) => result switch
    {
        OkObjectResult ok => ok.StatusCode ?? StatusCodes.Status200OK,
        OkResult => StatusCodes.Status200OK,
        UnauthorizedResult => StatusCodes.Status401Unauthorized,
        UnauthorizedObjectResult u => u.StatusCode ?? StatusCodes.Status401Unauthorized,
        ObjectResult o => o.StatusCode ?? StatusCodes.Status500InternalServerError,
        StatusCodeResult s => s.StatusCode,
        _ => StatusCodes.Status500InternalServerError,
    };

    private (AuthController Controller, ILogger<AuthController> Logger) CreateController(
        MosaicDbContext db, byte[] sessionToken)
    {
        var logger = Substitute.For<ILogger<AuthController>>();
        // ILogger.Log<TState> requires IsEnabled(LogLevel.Warning) == true so
        // the warning the controller emits on a serialization conflict is
        // actually dispatched to our NSubstitute mock.
        logger.IsEnabled(Arg.Any<LogLevel>()).Returns(true);
        var env = Substitute.For<IWebHostEnvironment>();
        env.EnvironmentName.Returns("Production");
        var cache = new MemoryCache(new MemoryCacheOptions());
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");
        http.Request.Headers["Cookie"] =
            $"mosaic_session={Convert.ToBase64String(sessionToken)}";

        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:Mode"] = "LocalAuth",
            })
            .Build();

        var controller = new AuthController(db, config, logger, env, cache, RustHost.Value, Mosaic.Backend.Security.KdfPolicy.ForTesting())
        {
            ControllerContext = new ControllerContext { HttpContext = http }
        };
        return (controller, logger);
    }

    /// <summary>
    /// Returns true if the supplied logger received a Warning-level Log call
    /// whose state stringifies to a message produced by the rotation retry
    /// loop (security-review-2026-05-19-07 / -10). We inspect the underlying
    /// <c>ILogger.Log&lt;TState&gt;</c> invocation rather than the extension
    /// methods so we can read the un-rendered structured-logging state.
    /// </summary>
    private static bool LoggerReceivedRotationConflictWarning(ILogger<AuthController> logger)
    {
        foreach (var call in logger.ReceivedCalls())
        {
            if (call.GetMethodInfo().Name != nameof(ILogger.Log))
            {
                continue;
            }
            var args = call.GetArguments();
            if (args.Length < 3 || args[0] is not LogLevel level || level != LogLevel.Warning)
            {
                continue;
            }
            var rendered = args[2]?.ToString();
            if (rendered != null &&
                (rendered.Contains("serialization/deadlock conflict", StringComparison.Ordinal) ||
                 rendered.Contains("exhausted", StringComparison.Ordinal)))
            {
                return true;
            }
        }
        return false;
    }

    private static User NewUser(byte[] authPubkey) => new()
    {
        Id = Guid.CreateVersion7(),
        AuthSub = "alice-" + Guid.NewGuid().ToString("N")[..8],
        IdentityPubkey = "id-pub",
        AuthPubkey = Convert.ToBase64String(authPubkey),
        UserSalt = RandomNumberGenerator.GetBytes(16),
        WrappedAccountKey = RandomNumberGenerator.GetBytes(72),
        SaltVersion = 1,
    };

    private static Session NewSession(Guid userId, out byte[] token)
    {
        token = RandomNumberGenerator.GetBytes(32);
        return new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = userId,
            TokenHash = SHA256.HashData(token),
            ExpiresAt = DateTime.UtcNow.AddDays(7),
            LastSeenAt = DateTime.UtcNow,
        };
    }

    private AuthChallenge NewChallenge(string username) => new()
    {
        Id = Guid.CreateVersion7(),
        Username = username,
        Challenge = RandomNumberGenerator.GetBytes(32),
        ExpiresAt = DateTime.UtcNow.AddMinutes(5),
        IsUsed = false,
        CreatedAt = DateTime.UtcNow,
        IpAddress = "127.0.0.1",
    };

    private static PasswordRotationRequest BuildRequest(
        AuthChallenge challenge, byte[] currentPubkey, byte[] currentSecret)
    {
        var (newPub, _) = GenerateEd25519();
        var msg = AuthChallengeTranscriptBuilder.BuildTranscript(
            challenge.Username, challenge.Challenge, null);
        using var k = Key.Import(SignatureAlgorithm.Ed25519, currentSecret, KeyBlobFormat.RawPrivateKey);
        var sig = Convert.ToBase64String(SignatureAlgorithm.Ed25519.Sign(k, msg));
        return new PasswordRotationRequest(
            ChallengeId: challenge.Id,
            CurrentSignature: sig,
            Timestamp: null,
            NewUserSalt: Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)),
            NewAuthPubkey: Convert.ToBase64String(newPub),
            NewWrappedAccountKey: Convert.ToBase64String(RandomNumberGenerator.GetBytes(72)));
    }

    private static (byte[] pubkey, byte[] secret) GenerateEd25519()
    {
        using var key = Key.Create(SignatureAlgorithm.Ed25519,
            new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        return (key.Export(KeyBlobFormat.RawPublicKey), key.Export(KeyBlobFormat.RawPrivateKey));
    }

    private static MosaicDbContext NewContext(string connStr, params IInterceptor[] interceptors)
    {
        var builder = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseNpgsql(connStr);
        if (interceptors.Length > 0)
        {
            builder = builder.AddInterceptors(interceptors);
        }
        return new MosaicDbContext(builder.Options);
    }

    // ---------- Interceptors ----------

    private sealed class BarrierOnSerializableTransactionInterceptor : IDbTransactionInterceptor
    {
        private readonly Barrier _barrier;
        private int _firedFlag;

        public BarrierOnSerializableTransactionInterceptor(Barrier barrier)
        {
            _barrier = barrier;
        }

        public bool Fired => Volatile.Read(ref _firedFlag) != 0;

        // Fires AFTER `BEGIN ISOLATION LEVEL SERIALIZABLE` has actually been
        // issued to Postgres — i.e. the transaction is open on the server
        // before either controller proceeds to read the user row or execute
        // its UPDATE. This is the true synchronization point for forcing a
        // Postgres SSI conflict (security-review-2026-05-19-10).
        public ValueTask<System.Data.Common.DbTransaction> TransactionStartedAsync(
            System.Data.Common.DbConnection connection,
            TransactionEndEventData eventData,
            System.Data.Common.DbTransaction result,
            CancellationToken cancellationToken = default)
        {
            if (result.IsolationLevel == System.Data.IsolationLevel.Serializable &&
                Interlocked.Exchange(ref _firedFlag, 1) == 0)
            {
                _barrier.SignalAndWait(TimeSpan.FromSeconds(30));
            }
            return new ValueTask<System.Data.Common.DbTransaction>(result);
        }

        public System.Data.Common.DbTransaction TransactionStarted(
            System.Data.Common.DbConnection connection,
            TransactionEndEventData eventData,
            System.Data.Common.DbTransaction result)
        {
            if (result.IsolationLevel == System.Data.IsolationLevel.Serializable &&
                Interlocked.Exchange(ref _firedFlag, 1) == 0)
            {
                _barrier.SignalAndWait(TimeSpan.FromSeconds(30));
            }
            return result;
        }
    }

    private sealed class FireOnceOnNthSaveInterceptor : ISaveChangesInterceptor
    {
        private readonly Func<Task> _hook;
        private readonly int _fireOnNthSave;
        private int _count;
        private bool _fired;

        public FireOnceOnNthSaveInterceptor(Func<Task> hook, int fireOnNthSave)
        {
            _hook = hook;
            _fireOnNthSave = fireOnNthSave;
        }

        public async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            var c = Interlocked.Increment(ref _count);
            if (!_fired && c == _fireOnNthSave)
            {
                _fired = true;
                await _hook();
            }
            return result;
        }

        public InterceptionResult<int> SavingChanges(
            DbContextEventData eventData, InterceptionResult<int> result)
        {
            var c = Interlocked.Increment(ref _count);
            if (!_fired && c == _fireOnNthSave)
            {
                _fired = true;
                _hook().GetAwaiter().GetResult();
            }
            return result;
        }
    }

    // ---------- Fixture ----------

    public sealed class PostgresFixture : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();

        public string ConnectionString => _container.GetConnectionString();

        public async Task InitializeAsync()
        {
            await _container.StartAsync();
            await using var db = CreateContext();
            await db.Database.EnsureCreatedAsync();
        }

        public async Task DisposeAsync()
        {
            await _container.DisposeAsync();
        }

        public MosaicDbContext CreateContext(params IInterceptor[] interceptors)
            => NewContext(ConnectionString, interceptors);

        public async Task ResetAsync()
        {
            await using var db = CreateContext();
            await db.Database.ExecuteSqlRawAsync(
                "TRUNCATE TABLE sessions, auth_challenges, users RESTART IDENTITY CASCADE");
        }
    }
}
