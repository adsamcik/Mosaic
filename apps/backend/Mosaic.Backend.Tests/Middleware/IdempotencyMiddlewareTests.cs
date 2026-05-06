using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
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
            context.Response.Headers.Location = $"/api/manifests/{calls}";
            await context.Response.WriteAsync($$"""{"id":"manifest-{{calls}}"}""");
        });

        var first = CreateContext("/api/manifests", "POST", """{"albumId":"a","shardIds":["s"]}""", "same-key");
        var second = CreateContext("/api/manifests", "POST", """{"albumId":"a","shardIds":["s"]}""", "same-key");

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(1, calls);
        Assert.Equal(StatusCodes.Status201Created, second.Response.StatusCode);
        Assert.Equal("/api/manifests/1", second.Response.Headers.Location.ToString());
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

        var first = CreateContext("/api/manifests", "POST", """{"albumId":"a"}""", "same-key");
        var second = CreateContext("/api/manifests", "POST", """{"albumId":"b"}""", "same-key");

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

        await middleware.InvokeAsync(CreateContext("/api/manifests", "POST", "{}", "key-one"), db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(CreateContext("/api/manifests", "POST", "{}", "key-two"), db, new MockCurrentUserService(db));

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

        await middleware.InvokeAsync(CreateContext("/api/manifests", "POST", "{}", "expiring-key"), db, new MockCurrentUserService(db));
        var record = db.IdempotencyRecords.Single();
        record.CreatedAt = now.AddHours(-25);
        await db.SaveChangesAsync();

        var replay = CreateContext("/api/manifests", "POST", "{}", "expiring-key");
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
            context.Response.Headers.Location = $"/api/files/upload-{calls}";
            return Task.CompletedTask;
        });

        var first = CreateContext("/api/files", "POST", string.Empty, "tus-key");
        first.Request.Headers["Tus-Resumable"] = "1.0.0";
        first.Request.Headers["Upload-Length"] = "1024";
        var second = CreateContext("/api/files", "POST", string.Empty, "tus-key");
        second.Request.Headers["Tus-Resumable"] = "1.0.0";
        second.Request.Headers["Upload-Length"] = "1024";

        await middleware.InvokeAsync(first, db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(second, db, new MockCurrentUserService(db));

        Assert.Equal(1, calls);
        Assert.Equal(StatusCodes.Status201Created, second.Response.StatusCode);
        Assert.Equal("/api/files/upload-1", second.Response.Headers.Location.ToString());
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

        await middleware.InvokeAsync(CreateContext("/api/files/upload-1", "PATCH", "chunk", "chunk-key"), db, new MockCurrentUserService(db));
        await middleware.InvokeAsync(CreateContext("/api/files/upload-1", "PATCH", "chunk", "chunk-key"), db, new MockCurrentUserService(db));

        Assert.Equal(2, calls);
        Assert.Empty(db.IdempotencyRecords);
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

    private static string ReadResponse(HttpContext context)
    {
        context.Response.Body.Position = 0;
        return new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true).ReadToEnd();
    }
}
