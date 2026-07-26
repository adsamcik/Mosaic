using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public sealed class SafeRequestPathTests
{
    [Theory]
    [InlineData("/api/v1/s/canary-link/shards/canary-shard", "/api/v1/s/{redacted}")]
    [InlineData("/api/v1/albums/canary-album", "/api/v1/albums/{redacted}")]
    [InlineData("/api/v1/files/canary-upload", "/api/v1/files/{redacted}")]
    [InlineData("/api/v1/tiles/12/2200/1400.png", "/api/v1/tiles/{redacted}")]
    [InlineData("/s/canary-link", "/s/{redacted}")]
    [InlineData("/health", "/health")]
    public void Redact_RemovesIdentifiersFromUnmatchedPaths(string input, string expected)
    {
        Assert.Equal(expected, SafeRequestPath.Redact(input));
        Assert.DoesNotContain("canary", SafeRequestPath.Redact(input), StringComparison.Ordinal);
    }

    [Fact]
    public void ForLogging_PrefersEndpointRouteTemplate()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/albums/canary-album";
        var pattern = RoutePatternFactory.Parse("/api/v1/albums/{albumId:guid}");
        context.SetEndpoint(new RouteEndpoint(_ => Task.CompletedTask, pattern, 0, null, "album"));

        var safePath = SafeRequestPath.ForLogging(context);

        Assert.Equal("/api/v1/albums/{albumId:guid}", safePath);
        Assert.DoesNotContain("canary-album", safePath, StringComparison.Ordinal);
    }
}
