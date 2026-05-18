using Microsoft.AspNetCore.Http;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class DeprecationHeadersMiddlewareTests
{
    private static async Task<DefaultHttpContext> RunAsync(Endpoint? endpoint)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        if (endpoint is not null)
        {
            context.SetEndpoint(endpoint);
        }

        var middleware = new DeprecationHeadersMiddleware(_ => Task.CompletedTask);
        await middleware.InvokeAsync(context);
        return context;
    }

    private static Endpoint EndpointWith(DeprecatedRouteAttribute attr) =>
        new(_ => Task.CompletedTask, new EndpointMetadataCollection(attr), "test");

    [Fact]
    public async Task NoEndpoint_EmitsNoDeprecationHeaders()
    {
        var ctx = await RunAsync(endpoint: null);

        Assert.False(ctx.Response.Headers.ContainsKey("Deprecation"));
        Assert.False(ctx.Response.Headers.ContainsKey("Sunset"));
        Assert.False(ctx.Response.Headers.ContainsKey("Link"));
    }

    [Fact]
    public async Task EndpointWithoutAttribute_EmitsNoDeprecationHeaders()
    {
        var endpoint = new Endpoint(_ => Task.CompletedTask, EndpointMetadataCollection.Empty, "plain");

        var ctx = await RunAsync(endpoint);

        Assert.False(ctx.Response.Headers.ContainsKey("Deprecation"));
        Assert.False(ctx.Response.Headers.ContainsKey("Sunset"));
    }

    [Fact]
    public async Task EndpointWithSunsetOnly_EmitsSunsetAndDeprecationTrue()
    {
        var endpoint = EndpointWith(new DeprecatedRouteAttribute { SunsetDate = "2027-01-01" });

        var ctx = await RunAsync(endpoint);

        Assert.Equal("true", ctx.Response.Headers["Deprecation"].ToString());
        Assert.Equal("Fri, 01 Jan 2027 00:00:00 GMT", ctx.Response.Headers["Sunset"].ToString());
        Assert.False(ctx.Response.Headers.ContainsKey("Link"));
    }

    [Fact]
    public async Task EndpointWithDeprecationDate_EmitsDeprecationAsHttpDate()
    {
        var endpoint = EndpointWith(new DeprecatedRouteAttribute
        {
            DeprecationDate = "2026-12-01",
            SunsetDate = "2027-01-01",
        });

        var ctx = await RunAsync(endpoint);

        Assert.Equal("Tue, 01 Dec 2026 00:00:00 GMT", ctx.Response.Headers["Deprecation"].ToString());
        Assert.Equal("Fri, 01 Jan 2027 00:00:00 GMT", ctx.Response.Headers["Sunset"].ToString());
    }

    [Fact]
    public async Task EndpointWithLink_EmitsSuccessorVersionLink()
    {
        var endpoint = EndpointWith(new DeprecatedRouteAttribute
        {
            SunsetDate = "2027-01-01",
            Link = "https://docs.mosaic.example/api/v2/albums",
        });

        var ctx = await RunAsync(endpoint);

        Assert.Equal(
            "<https://docs.mosaic.example/api/v2/albums>; rel=\"successor-version\"",
            ctx.Response.Headers["Link"].ToString());
    }

    [Fact]
    public async Task InvalidSunsetDate_ThrowsInvalidOperation()
    {
        var endpoint = EndpointWith(new DeprecatedRouteAttribute { SunsetDate = "not-a-date" });

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(async () => await RunAsync(endpoint));
        Assert.Contains("SunsetDate", ex.Message);
    }

    [Fact]
    public async Task InvalidDeprecationDate_ThrowsInvalidOperation()
    {
        var endpoint = EndpointWith(new DeprecatedRouteAttribute
        {
            SunsetDate = "2027-01-01",
            DeprecationDate = "tomorrow",
        });

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(async () => await RunAsync(endpoint));
        Assert.Contains("DeprecationDate", ex.Message);
    }
}
