using Microsoft.AspNetCore.Http;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class TusVersionRejectionTests
{
    private static async Task<DefaultHttpContext> RunAsync(
        string path,
        string? tusResumable,
        Action<DefaultHttpContext>? configure = null)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Path = path;
        if (tusResumable is not null)
        {
            context.Request.Headers["Tus-Resumable"] = tusResumable;
        }
        configure?.Invoke(context);

        var middleware = new TusVersionMiddleware(ctx =>
        {
            // If the request was forwarded to the next middleware, mark with 200.
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            return Task.CompletedTask;
        });
        await middleware.InvokeAsync(context);
        return context;
    }

    [Fact]
    public async Task Tus2_OnTusPath_Returns412()
    {
        var ctx = await RunAsync("/api/v1/files", "2.0.0");

        Assert.Equal(StatusCodes.Status412PreconditionFailed, ctx.Response.StatusCode);
        Assert.Equal("1.0.0", ctx.Response.Headers["Tus-Version"].ToString());
    }

    [Fact]
    public async Task Tus2_OnTusPath_AdvertisesSupportedVersion()
    {
        var ctx = await RunAsync("/api/v1/files/abc123", "2.0.0");

        Assert.Equal(412, ctx.Response.StatusCode);
        Assert.Equal("1.0.0", ctx.Response.Headers["Tus-Version"].ToString());

        ctx.Response.Body.Position = 0;
        var body = await new StreamReader(ctx.Response.Body).ReadToEndAsync();
        Assert.Contains("2.0.0", body);
        Assert.Contains("1.0.0", body);
    }

    [Fact]
    public async Task Tus1_OnTusPath_PassesThrough()
    {
        var ctx = await RunAsync("/api/v1/files", "1.0.0");

        Assert.Equal(StatusCodes.Status200OK, ctx.Response.StatusCode);
        Assert.False(ctx.Response.Headers.ContainsKey("Tus-Version"));
    }

    [Fact]
    public async Task NoTusResumableHeader_OnTusPath_PassesThrough()
    {
        // OPTIONS-style discovery requests are allowed to reach tusdotnet without
        // a Tus-Resumable header.
        var ctx = await RunAsync("/api/v1/files", tusResumable: null);

        Assert.Equal(StatusCodes.Status200OK, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Tus2_OnNonTusPath_PassesThrough()
    {
        // Non-Tus routes may legitimately carry a Tus-Resumable header in the
        // idempotency hash material; we don't gate them.
        var ctx = await RunAsync("/api/v1/albums", "2.0.0");

        Assert.Equal(StatusCodes.Status200OK, ctx.Response.StatusCode);
        Assert.False(ctx.Response.Headers.ContainsKey("Tus-Version"));
    }

    [Fact]
    public async Task UnknownTusVersion_OnTusPath_Returns412()
    {
        var ctx = await RunAsync("/api/v1/files", "0.9.0");

        Assert.Equal(412, ctx.Response.StatusCode);
        Assert.Equal("1.0.0", ctx.Response.Headers["Tus-Version"].ToString());
    }
}
