using System.Net;
using System.Net.Http;
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
/// Regression coverage for validation-2026-05-19-playwright-01.
///
/// E2E global-setup calls <c>POST /api/v1/test-seed/reset</c> and
/// <c>POST /api/v1/test-seed/ensure-pool</c> from Node's bare
/// <c>fetch</c>, which emits no <c>Sec-Fetch-Site</c> and no <c>Origin</c>
/// header. Without an exemption, <see cref="OriginValidationMiddleware"/>
/// rejects every state-changing request from non-browser tooling with
/// <c>403 Forbidden</c>, killing the full Playwright suite at global
/// setup.
///
/// The middleware must:
///  - Exempt <c>/api/v1/test-seed/*</c> in <c>Development</c>/<c>Testing</c> environments.
///  - NOT exempt it in <c>Production</c> (preserves the strict default).
/// </summary>
public class OriginValidationMiddlewareTestSeedExemptionTests
{
    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    public async Task TestSeedEndpoint_IsExempt_InTestEnvironments(string environmentName)
    {
        using var host = await BuildHostAsync(environmentName);
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/test-seed/reset");
        // Intentionally omit Sec-Fetch-Site and Origin — mirrors Node fetch().

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task TestSeedEndpoint_IsRejected_InProduction()
    {
        using var host = await BuildHostAsync("Production");
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/test-seed/reset");

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task NonTestSeedEndpoint_StillRejected_InDevelopment()
    {
        // Sanity: dev exemption must NOT broaden to other paths.
        // A state-changing request that *does* claim a cross-site origin
        // must still be rejected — only header-less non-browser tooling
        // is trusted in Dev/Testing.
        using var host = await BuildHostAsync("Development");
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/albums");
        req.Headers.Add("Sec-Fetch-Site", "cross-site");

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Testing")]
    public async Task HeaderlessStateChange_IsAllowed_InTestEnvironments(string environmentName)
    {
        // v1.0.x album-create-403: E2E pool fixtures (Playwright
        // global-setup, test-data-factory) hit POST /api/v1/albums from
        // Node's bare `fetch`, which emits neither Sec-Fetch-Site nor
        // Origin. Before the fix this hit a blanket 403 from
        // OriginValidationMiddleware and blocked the P1-COLLAB-1/5/6/7
        // collaboration spec tests.
        using var host = await BuildHostAsync(environmentName);
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/albums");
        // Intentionally omit Sec-Fetch-Site and Origin — mirrors Node fetch().

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task HeaderlessStateChange_IsRejected_InProduction()
    {
        // Production must preserve the strict CSRF default: a real
        // browser ALWAYS sets at least Sec-Fetch-Site or Origin on
        // POST/PUT/PATCH/DELETE; a request missing both is hostile or
        // misconfigured tooling.
        using var host = await BuildHostAsync("Production");
        var client = host.GetTestClient();

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/albums");

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    private static async Task<IHost> BuildHostAsync(string environmentName)
    {
        var host = await new HostBuilder()
            .UseEnvironment(environmentName)
            .ConfigureWebHost(web =>
            {
                web.UseTestServer();
                web.Configure(app =>
                {
                    app.UseMiddleware<OriginValidationMiddleware>();
                    app.Run(ctx =>
                    {
                        // Stand-in for the downstream controller — returns 200
                        // so we can distinguish "middleware passed through" from
                        // "middleware rejected with 403".
                        ctx.Response.StatusCode = StatusCodes.Status200OK;
                        return Task.CompletedTask;
                    });
                });
            })
            .StartAsync();
        return host;
    }
}
