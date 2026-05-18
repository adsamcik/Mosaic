using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class IdempotencyMiddlewareTests
{
    private const string AuthSub = "idempotency-user";

    [Fact]
    public async Task ManifestPost_SameKeyAndSameBody_ReturnsCachedResponse()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(async context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status201Created;
            context.Response.Headers.Location = $"/api/v1/manifests/{calls}";
            await context.Response.WriteAsync($$"""{"id":"manifest-{{calls}}"}""");
        });

        var first = CreateContext("/api/v1/manifests", "POST", """{"albumId":"a","shardIds":["s"]}""", "same-key");
        var second = CreateContext("/api/v1/manifests", "POST", """{"albumId":"a","shardIds":["s"]}""", "same-key");

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(1, calls);
        Assert.Equal(StatusCodes.Status201Created, second.Response.StatusCode);
        Assert.Equal("/api/v1/manifests/1", second.Response.Headers.Location.ToString());
        Assert.Equal("""{"id":"manifest-1"}""", ReadResponse(second));
        Assert.Equal("true", second.Response.Headers["Idempotency-Replayed"].ToString());
    }

    [Fact]
    public async Task ManifestPost_SameKeyAndDifferentBody_ReturnsConflict()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(async context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status201Created;
            await context.Response.WriteAsync($$"""{"id":"manifest-{{calls}}"}""");
        });

        var first = CreateContext("/api/v1/manifests", "POST", """{"albumId":"a"}""", "same-key");
        var second = CreateContext("/api/v1/manifests", "POST", """{"albumId":"b"}""", "same-key");

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(1, calls);
        Assert.Equal(StatusCodes.Status409Conflict, second.Response.StatusCode);
        Assert.Contains("Idempotency-Key conflict", ReadResponse(second), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ManifestPost_DifferentKeys_ProcessesBothRequests()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(async context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status201Created;
            await context.Response.WriteAsync($$"""{"id":"manifest-{{calls}}"}""");
        });

        await middleware.InvokeAsync(CreateContext("/api/v1/manifests", "POST", "{}", "key-one"), db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(CreateContext("/api/v1/manifests", "POST", "{}", "key-two"), db, new MockCurrentUserService(db));

        Assert.Equal(2, calls);
        Assert.Equal(2, db.IdempotencyRecords.Count());
    }

    [Fact]
    public async Task ManifestPost_ExpiredRecord_IsBypassedAndReplaced()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 29, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);
        var calls = 0;
        var middleware = CreateMiddleware(async context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status201Created;
            await context.Response.WriteAsync($$"""{"id":"manifest-{{calls}}"}""");
        }, timeProvider);

        await middleware.InvokeAsync(CreateContext("/api/v1/manifests", "POST", "{}", "expiring-key"), db, new MockCurrentUserService(db));
        var record = db.IdempotencyRecords.Single();
        record.CreatedAt = now.AddHours(-25);
        await db.SaveChangesAsync();

        var replay = CreateContext("/api/v1/manifests", "POST", "{}", "expiring-key");
        await middleware.InvokeAsync(replay, db, new MockCurrentUserService(db));

        Assert.Equal(2, calls);
        Assert.Equal("""{"id":"manifest-2"}""", ReadResponse(replay));
        Assert.DoesNotContain("Idempotency-Replayed", replay.Response.Headers.Keys);
    }

    [Fact]
    public async Task TusPost_SameKeyAndSameUploadHeaders_ReturnsCachedInitHandshake()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status201Created;
            context.Response.Headers.Location = $"/api/v1/files/upload-{calls}";
            return Task.CompletedTask;
        });

        var first = CreateContext("/api/v1/files", "POST", string.Empty, "tus-key");
        first.Request.Headers["Tus-Resumable"] = "1.0.0";
        first.Request.Headers["Upload-Length"] = "1024";
        var second = CreateContext("/api/v1/files", "POST", string.Empty, "tus-key");
        second.Request.Headers["Tus-Resumable"] = "1.0.0";
        second.Request.Headers["Upload-Length"] = "1024";

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(1, calls);
        Assert.Equal(StatusCodes.Status201Created, second.Response.StatusCode);
        Assert.Equal("/api/v1/files/upload-1", second.Response.Headers.Location.ToString());
        Assert.Equal("true", second.Response.Headers["Idempotency-Replayed"].ToString());
    }

    [Fact]
    public async Task TusPatch_WithIdempotencyKey_IsUnaffectedByReplayCache()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });

        await middleware.InvokeAsync(CreateContext("/api/v1/files/upload-1", "PATCH", "chunk", "chunk-key"), db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(CreateContext("/api/v1/files/upload-1", "PATCH", "chunk", "chunk-key"), db, new MockCurrentUserService(db));

        Assert.Equal(2, calls);
        Assert.Empty(db.IdempotencyRecords);
    }

    [Fact]
    public async Task ConcurrentIdenticalRequests_ExecuteSideEffectsExactlyOnce()
    {
        const int requestCount = 10;
        var options = CreateSharedOptions();
        await using (var seedDb = new MosaicDbContext(options))
        {
            await SeedUserAsync(seedDb);
        }

        var sideEffectCount = 0;
        var middleware = CreateMiddleware(async context =>
        {
            var call = Interlocked.Increment(ref sideEffectCount);
            context.Response.StatusCode = StatusCodes.Status201Created;
            context.Response.Headers.Location = $"/api/v1/manifests/{call}";
            await context.Response.WriteAsync($$"""{"id":"manifest-{{call}}"}""");
            await Task.Delay(50);
        });

        var tasks = Enumerable.Range(0, requestCount).Select(async _ =>
        {
            await using var db = new MosaicDbContext(options);
            var context = CreateContext("/api/v1/manifests", "POST", """{"albumId":"a","shardIds":["s"]}""", "concurrent-key");

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

        Assert.Equal(1, sideEffectCount);
        Assert.All(results, result => Assert.Equal(StatusCodes.Status201Created, result.StatusCode));
        Assert.All(results, result => Assert.Equal("/api/v1/manifests/1", result.Location));
        Assert.All(results, result => Assert.Equal("""{"id":"manifest-1"}""", result.Body));
        Assert.Equal(requestCount - 1, results.Count(result => result.Replayed == "true"));
    }

    [Fact]
    public async Task ManifestPost_ServerErrorResponse_IsNotCached()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(async context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await context.Response.WriteAsync($$"""{"error":"unavailable-{{calls}}"}""");
        });

        var first = CreateContext("/api/v1/manifests", "POST", "{}", "server-error-key");
        var second = CreateContext("/api/v1/manifests", "POST", "{}", "server-error-key");

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(2, calls);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, second.Response.StatusCode);
        Assert.Equal("""{"error":"unavailable-2"}""", ReadResponse(second));
        Assert.DoesNotContain("Idempotency-Replayed", second.Response.Headers.Keys);
        Assert.Empty(db.IdempotencyRecords);
    }

    [Fact]
    public async Task ManifestPost_ClientErrorResponse_IsCached()
    {
        using var db = TestDbContextFactory.Create();
        var calls = 0;
        var middleware = CreateMiddleware(async context =>
        {
            calls++;
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsync($$"""{"error":"bad-request-{{calls}}"}""");
        });

        var first = CreateContext("/api/v1/manifests", "POST", "{}", "client-error-key");
        var second = CreateContext("/api/v1/manifests", "POST", "{}", "client-error-key");

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(1, calls);
        Assert.Equal(StatusCodes.Status400BadRequest, second.Response.StatusCode);
        Assert.Equal("""{"error":"bad-request-1"}""", ReadResponse(second));
        Assert.Equal("true", second.Response.Headers["Idempotency-Replayed"].ToString());
        Assert.Single(db.IdempotencyRecords);
    }

    [Fact]
    public async Task IdempotencyRecord_IsPersisted_BeforeResponseFlushedToClient()
    {
        // Regression for v1.0.x s47-y3: the controller's domain transaction
        // commits BEFORE control returns to the middleware, and the middleware
        // must persist the IdempotencyRecord BEFORE flushing the response to
        // the client. Otherwise a client that sees a 201 could retry on a
        // transient network error and miss the replay cache, creating a
        // duplicate manifest. This test verifies the persisted-before-flushed
        // invariant by inspecting the response stream contents only after the
        // record is in the DB context's tracked changes.
        using var db = TestDbContextFactory.Create();
        IdempotencyRecord? capturedAtFlushTime = null;

        var middleware = CreateMiddleware(async context =>
        {
            context.Response.StatusCode = StatusCodes.Status201Created;
            await context.Response.WriteAsync("""{"id":"manifest-1"}""");
        });

        var ctx = CreateContext("/api/v1/manifests", "POST", """{"albumId":"a"}""", "atomic-key");

        await middleware.InvokeAsync(ctx, db, new MockCurrentUserService(db));

        // After the middleware returns, BOTH must be true:
        //   1. The response body is fully written.
        //   2. The IdempotencyRecord is persisted (queryable).
        capturedAtFlushTime = await db.IdempotencyRecords
            .FirstOrDefaultAsync(r => r.IdempotencyKey == "atomic-key");

        Assert.NotNull(capturedAtFlushTime);
        Assert.Equal(StatusCodes.Status201Created, capturedAtFlushTime!.ResponseStatus);
        Assert.Equal("""{"id":"manifest-1"}""", System.Text.Encoding.UTF8.GetString(capturedAtFlushTime.ResponseBody));
        Assert.Equal("""{"id":"manifest-1"}""", ReadResponse(ctx));
    }

    private static IdempotencyMiddleware CreateMiddleware(RequestDelegate next, TimeProvider? timeProvider = null)
        => new(
            next,
            NullLogger<IdempotencyMiddleware>.Instance,
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Idempotency:RecordTtlHours"] = "24"
            }).Build(),
            timeProvider ?? TimeProvider.System);

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

    private static DbContextOptions<MosaicDbContext> CreateSharedOptions()
        => new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString(), new InMemoryDatabaseRoot())
            .Options;

    private static async Task SeedUserAsync(MosaicDbContext db)
    {
        db.Users.Add(new User
        {
            Id = Guid.NewGuid(),
            AuthSub = AuthSub,
            IdentityPubkey = ""
        });
        await db.SaveChangesAsync();
    }

    private static string ReadResponse(HttpContext context)
    {
        context.Response.Body.Position = 0;
        return new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true).ReadToEnd();
    }
}
