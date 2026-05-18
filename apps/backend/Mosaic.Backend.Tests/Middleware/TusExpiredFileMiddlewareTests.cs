using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

/// <summary>
/// Verifies v1.0.x s44-y5: tusdotnet's bare-404 on a missing upload file is
/// rewritten into a localized RFC 7807 ProblemDetails carrying
/// <c>type=upload-session-expired</c>.
/// </summary>
/// <remarks>
/// Exercised against an in-process minimal pipeline (no auth, no MapTus)
/// rather than the full <c>WebApplicationFactory&lt;Program&gt;</c> stack —
/// the middleware itself is pure response-shaping over the downstream's
/// status code, so a stub downstream that returns 404 is sufficient and
/// avoids the test having to log in or pass through the bearer-auth gate.
/// </remarks>
public class TusExpiredFileMiddlewareTests
{
    [Fact]
    public async Task HeadOnMissingFile_RewritesTo_ProblemDetails()
    {
        using var host = await BuildHostAsync(downstreamStatus: 404);
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Head, $"/api/v1/files/{new string('a', 32)}");
        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal("application/problem+json", resp.Content.Headers.ContentType?.MediaType);

        // HEAD has no body — assert via Content-Type/Status alone. Repeat with GET
        // (which DOES have a body) for full structural verification.
        var getReq = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/files/{new string('a', 32)}");
        var getResp = await client.SendAsync(getReq);
        Assert.Equal(HttpStatusCode.NotFound, getResp.StatusCode);
        var body = await getResp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        Assert.Equal(
            "https://docs.mosaic.app/errors/upload-session-expired",
            doc.RootElement.GetProperty("type").GetString());
        Assert.Equal(404, doc.RootElement.GetProperty("status").GetInt32());
        Assert.False(string.IsNullOrEmpty(doc.RootElement.GetProperty("title").GetString()));
        Assert.False(string.IsNullOrEmpty(doc.RootElement.GetProperty("detail").GetString()));
    }

    [Fact]
    public async Task PatchOnMissingFile_RewritesTo_ProblemDetails()
    {
        using var host = await BuildHostAsync(downstreamStatus: 404);
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Patch, $"/api/v1/files/{new string('b', 32)}")
        {
            Content = new ByteArrayContent(new byte[] { 1, 2, 3 })
        };
        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal("application/problem+json", resp.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task PostUploadCreate_NotIntercepted_EvenOnDownstream404()
    {
        using var host = await BuildHostAsync(downstreamStatus: 404);
        var client = host.GetTestClient();

        // POST against the bare mount point is the upload-creation path. A 404
        // there is a genuine route mismatch, not an expired upload, so the
        // middleware must NOT rewrite it.
        var resp = await client.PostAsync("/api/v1/files", new ByteArrayContent(Array.Empty<byte>()));
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.NotEqual("application/problem+json", resp.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task NonTusPath_NotIntercepted()
    {
        using var host = await BuildHostAsync(downstreamStatus: 404);
        var client = host.GetTestClient();

        var resp = await client.GetAsync("/api/v1/this-route-does-not-exist");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.NotEqual("application/problem+json", resp.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Non404Response_PassesThrough()
    {
        using var host = await BuildHostAsync(downstreamStatus: 204);
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Head, $"/api/v1/files/{new string('c', 32)}");
        var resp = await client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    private static async Task<IHost> BuildHostAsync(int downstreamStatus)
    {
        var host = await new HostBuilder()
            .ConfigureWebHost(web =>
            {
                web.UseTestServer();
                web.ConfigureServices(services => services.AddLocalization());
                web.Configure(app =>
                {
                    app.UseMiddleware<TusExpiredFileMiddleware>();
                    app.Run(ctx =>
                    {
                        ctx.Response.StatusCode = downstreamStatus;
                        return Task.CompletedTask;
                    });
                });
            })
            .StartAsync();
        return host;
    }
}
