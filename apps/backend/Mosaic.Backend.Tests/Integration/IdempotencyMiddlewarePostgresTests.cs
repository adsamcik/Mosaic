extern alias TestcontainersPostgreSql;

using System.IO.Pipes;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Tests.Helpers;
using Npgsql;
using TestcontainersPostgreSql::Testcontainers.PostgreSql;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

public sealed class IdempotencyMiddlewarePostgresTests : IClassFixture<IdempotencyMiddlewarePostgresTests.PostgresFixture>
{
    private const string AuthSub = "idempotency-postgres-user";
    private readonly PostgresFixture _fixture;

    public IdempotencyMiddlewarePostgresTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task AdvisoryLock_NestedTransaction_DoesNotThrow()
    {
        await ResetDatabaseAsync();
        await using var db = CreateDbContext();
        var middleware = CreateMiddleware(async context =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(context.RequestAborted);
            context.Response.StatusCode = StatusCodes.Status201Created;
            await context.Response.WriteAsync("""{"ok":true}""");
            await transaction.CommitAsync(context.RequestAborted);
        });
        var context = CreateContext("/api/manifests", "POST", "{}", "nested-transaction-key");

        var exception = await Record.ExceptionAsync(() => middleware.InvokeAsync(context, db, new MockCurrentUserService(db)));

        Assert.Null(exception);
        Assert.Equal(StatusCodes.Status201Created, context.Response.StatusCode);
        Assert.Equal("""{"ok":true}""", ReadResponse(context));
        Assert.Single(db.IdempotencyRecords);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task AdvisoryLock_ConcurrentIdenticalRequests_SerializesViaPgAdvisoryLock()
    {
        const int requestCount = 10;
        await ResetDatabaseAsync();
        await SeedUserAsync();
        var sideEffectCount = 0;
        var middleware = CreateMiddleware(async context =>
        {
            var call = Interlocked.Increment(ref sideEffectCount);
            await Task.Delay(50, context.RequestAborted);
            context.Response.StatusCode = StatusCodes.Status201Created;
            context.Response.Headers.Location = $"/api/manifests/{call}";
            await context.Response.WriteAsync($$"""{"id":"manifest-{{call}}"}""");
        });

        var tasks = Enumerable.Range(0, requestCount).Select(async _ =>
        {
            await using var db = CreateDbContext();
            var context = CreateContext("/api/manifests", "POST", """{"albumId":"a","shardIds":["s"]}""", "pg-concurrent-key");

            await middleware.InvokeAsync(context, db, new MockCurrentUserService(db));

            return new
            {
                context.Response.StatusCode,
                Location = context.Response.Headers.Location.ToString(),
                Replayed = context.Response.Headers["Idempotency-Replayed"].ToString(),
                Body = ReadResponse(context)
            };
        });

        var results = await Task.WhenAll(tasks);
        await using var verifyDb = CreateDbContext();

        Assert.Equal(1, sideEffectCount);
        Assert.All(results, result => Assert.Equal(StatusCodes.Status201Created, result.StatusCode));
        Assert.All(results, result => Assert.Equal("/api/manifests/1", result.Location));
        Assert.All(results, result => Assert.Equal("""{"id":"manifest-1"}""", result.Body));
        Assert.Equal(requestCount - 1, results.Count(result => result.Replayed == "true"));
        Assert.Single(verifyDb.IdempotencyRecords);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task AdvisoryLock_ConnectionClose_ReleasesLock()
    {
        await ResetDatabaseAsync();
        var lockKey = IdempotencyMiddleware.ComputeAdvisoryLockKey(
            Guid.Parse("22222222-2222-2222-2222-222222222222"),
            "connection-close-key");
        var noPoolingConnectionString = new NpgsqlConnectionStringBuilder(_fixture.ConnectionString)
        {
            Pooling = false
        }.ConnectionString;

        await using (var holder = new NpgsqlConnection(noPoolingConnectionString))
        {
            await holder.OpenAsync();
            await ExecuteAdvisoryCommandAsync(holder, "SELECT pg_advisory_lock(@key)", lockKey, CancellationToken.None);
        }

        await using var acquirer = new NpgsqlConnection(noPoolingConnectionString);
        await acquirer.OpenAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await using var command = acquirer.CreateCommand();
        command.CommandText = "SELECT pg_try_advisory_lock(@key)";
        command.Parameters.AddWithValue("key", lockKey);

        var acquired = (bool)(await command.ExecuteScalarAsync(timeout.Token) ?? false);

        Assert.True(acquired);
        await ExecuteAdvisoryCommandAsync(acquirer, "SELECT pg_advisory_unlock(@key)", lockKey, CancellationToken.None);
    }

    private MosaicDbContext CreateDbContext()
        => new(CreateOptions());

    private DbContextOptions<MosaicDbContext> CreateOptions()
        => new DbContextOptionsBuilder<MosaicDbContext>()
            .UseNpgsql(_fixture.ConnectionString)
            .Options;

    private async Task ResetDatabaseAsync()
    {
        await using var db = CreateDbContext();
        await db.Database.EnsureCreatedAsync();
        await db.Database.ExecuteSqlRawAsync("TRUNCATE TABLE idempotency_records, user_quotas, users RESTART IDENTITY CASCADE");
    }

    private async Task SeedUserAsync()
    {
        await using var db = CreateDbContext();
        db.Users.Add(new User
        {
            Id = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            AuthSub = AuthSub,
            IdentityPubkey = ""
        });
        await db.SaveChangesAsync();
    }

    private static IdempotencyMiddleware CreateMiddleware(RequestDelegate next)
        => new(
            next,
            NullLogger<IdempotencyMiddleware>.Instance,
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Idempotency:RecordTtlHours"] = "24"
            }).Build(),
            TimeProvider.System);

    private static DefaultHttpContext CreateContext(string path, string method, string body, string key)
    {
        var context = new DefaultHttpContext();
        context.Items["AuthSub"] = AuthSub;
        context.Request.Path = path;
        context.Request.Method = method;
        context.Request.Headers[IdempotencyMiddleware.HeaderName] = key;
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static string ReadResponse(HttpContext context)
    {
        context.Response.Body.Position = 0;
        return new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true).ReadToEnd();
    }

    private static async Task ExecuteAdvisoryCommandAsync(
        NpgsqlConnection connection,
        string commandText,
        long lockKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = commandText;
        command.Parameters.AddWithValue("key", lockKey);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public sealed class PostgresFixture : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();

        public string ConnectionString => _container.GetConnectionString();

        public Task InitializeAsync() => _container.StartAsync();

        public async Task DisposeAsync()
        {
            await _container.DisposeAsync();
        }
    }
}

public sealed class IdempotencyMiddlewarePostgresKeyTests
{
    [Fact]
    [Trait("Category", "Integration")]
    public void AdvisoryLock_KeyDerivation_Stable()
    {
        var userId = Guid.Parse("11111111-1111-1111-1111-111111111111");
        const string idempotencyKey = "stable-key";
        const long expectedLittleEndianLockKey = 2717993901828388487L;

        var first = IdempotencyMiddleware.ComputeAdvisoryLockKey(userId, idempotencyKey);
        for (var i = 0; i < 1000; i++)
        {
            Assert.Equal(first, IdempotencyMiddleware.ComputeAdvisoryLockKey(userId, idempotencyKey));
        }

        Assert.Equal(expectedLittleEndianLockKey, first);
    }
}

internal sealed class DockerRequiredFactAttribute : FactAttribute
{
    public DockerRequiredFactAttribute()
    {
        if (!IsDockerAvailable())
        {
            Skip = "Docker required for Testcontainers PostgreSQL integration test.";
        }
    }

    private static bool IsDockerAvailable()
    {
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DOCKER_HOST")))
        {
            return true;
        }

        if (!OperatingSystem.IsWindows())
        {
            return File.Exists("/var/run/docker.sock");
        }

        try
        {
            using var pipe = new NamedPipeClientStream(".", "docker_engine", PipeDirection.InOut);
            pipe.Connect(250);
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }
}
