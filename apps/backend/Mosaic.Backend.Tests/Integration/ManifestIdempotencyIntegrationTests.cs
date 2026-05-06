using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

public class ManifestIdempotencyIntegrationTests
{
    private const string AuthSub = "idempotency-integration-user";

    [Fact]
    public async Task ManifestPost_SameIdempotencyKeyAndBody_ReplaysCachedResponse()
    {
        using var db = TestDbContextFactory.Create();
        var currentUser = new MockCurrentUserService(db);
        var executed = 0;
        var middleware = CreateMiddleware(async context =>
        {
            executed++;
            context.Response.StatusCode = StatusCodes.Status201Created;
            context.Response.Headers.Location = "/api/manifests/manifest-id";
            await context.Response.WriteAsync("""{"manifestId":"manifest-id"}""");
        });

        var first = CreateContext("""{"protocolVersion":1,"tieredShards":[]}""", "same-key");
        await middleware.InvokeAsync(first, db, currentUser);
        var second = CreateContext("""{"protocolVersion":1,"tieredShards":[]}""", "same-key");
        await middleware.InvokeAsync(second, db, currentUser);

        Assert.Equal(1, executed);
        Assert.Equal(StatusCodes.Status201Created, second.Response.StatusCode);
        Assert.Equal("true", second.Response.Headers["Idempotency-Replayed"].ToString());
        Assert.Equal(ReadBody(first), ReadBody(second));
    }

    [Fact]
    public async Task ManifestPost_SameIdempotencyKeyDifferentBody_ReturnsConflict()
    {
        using var db = TestDbContextFactory.Create();
        var currentUser = new MockCurrentUserService(db);
        var middleware = CreateMiddleware(async context =>
        {
            context.Response.StatusCode = StatusCodes.Status201Created;
            await context.Response.WriteAsync("""{"manifestId":"manifest-id"}""");
        });

        var first = CreateContext("""{"protocolVersion":1,"tieredShards":[{"shardId":"a"}]}""", "conflict-key");
        await middleware.InvokeAsync(first, db, currentUser);
        var second = CreateContext("""{"protocolVersion":1,"tieredShards":[{"shardId":"b"}]}""", "conflict-key");
        await middleware.InvokeAsync(second, db, currentUser);

        Assert.Equal(StatusCodes.Status409Conflict, second.Response.StatusCode);
        Assert.Contains("Idempotency-Key conflict", ReadBody(second), StringComparison.Ordinal);
    }

    private static IdempotencyMiddleware CreateMiddleware(RequestDelegate next)
        => new(
            next,
            NullLoggerFactory.CreateNullLogger<IdempotencyMiddleware>(),
            TestConfiguration.Create(),
            TimeProvider.System);

    private static DefaultHttpContext CreateContext(string body, string idempotencyKey)
    {
        var context = new DefaultHttpContext();
        context.Items["AuthSub"] = AuthSub;
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/manifests";
        context.Request.ContentType = "application/json";
        context.Request.Headers[IdempotencyMiddleware.HeaderName] = idempotencyKey;
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        context.Response.Body = new MemoryStream();
        context.Response.Headers.ContentType = new StringValues("application/json");
        return context;
    }

    private static string ReadBody(HttpContext context)
    {
        context.Response.Body.Position = 0;
        using var reader = new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true);
        var body = reader.ReadToEnd();
        context.Response.Body.Position = 0;
        return body;
    }
}
