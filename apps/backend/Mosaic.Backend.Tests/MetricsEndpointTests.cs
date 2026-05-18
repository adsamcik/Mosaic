using System;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests;

/// <summary>
/// Integration tests for the localhost-only <c>GET /metrics</c> endpoint.
/// The endpoint must (a) serve Prometheus-text from loopback callers and
/// (b) refuse any non-loopback caller with 403 — there is no auth in
/// front of <c>/metrics</c>, so the IP gate is the only access control.
/// </summary>
public sealed class MetricsEndpointTests
    : IClassFixture<SidecarSignalingTests.DefaultFactory>
{
    private readonly SidecarSignalingTests.DefaultFactory _factory;

    public MetricsEndpointTests(SidecarSignalingTests.DefaultFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Metrics_FromLoopback_Returns200WithPrometheusText()
    {
        using var client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
        });

        // TestServer sets RemoteIpAddress to IPv6Loopback (::1) by default,
        // which IPAddress.IsLoopback accepts — so this is the "from
        // localhost" path.
        var response = await client.GetAsync("/metrics");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(response.Content.Headers.ContentType);
        Assert.Equal("text/plain", response.Content.Headers.ContentType!.MediaType);

        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("mosaic_uploads_total", body);
        Assert.Contains("mosaic_auth_failures_total", body);
        Assert.Contains("mosaic_orphan_blob_delete_failures_total", body);
        Assert.Contains("mosaic_gc_duration_seconds_count", body);
    }

    [Fact]
    public async Task Metrics_ReflectsLiveCounterIncrements()
    {
        using var client = _factory.CreateClient();

        // Resolve the singleton the running test host registered and mutate
        // it directly — proves /metrics renders live values, not a stale
        // snapshot captured at startup.
        var metrics = _factory.Services.GetRequiredService<MosaicMetrics>();
        var before = metrics.UploadsTotalValue;
        metrics.RecordUpload();
        metrics.RecordUpload();

        var body = await client.GetStringAsync("/metrics");

        Assert.Contains($"mosaic_uploads_total {before + 2}", body);
    }

    [Fact]
    public async Task Metrics_FromNonLoopback_Returns403()
    {
        // Inject a startup filter that rewrites the connection peer to a
        // public IP, simulating a request that arrived from outside the
        // loopback interface. The /metrics IP gate must reject it with
        // 403 — there is no auth in front of this endpoint, so the gate
        // is the only thing preventing public exposure.
        using var spoofedFactory = new NonLoopbackFactory();
        using var client = spoofedFactory.CreateClient();

        var response = await client.GetAsync("/metrics");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    private sealed class NonLoopbackFactory : SidecarSignalingTests.Factory
    {
        public NonLoopbackFactory() : base(null) { }

        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.ConfigureServices(services =>
            {
                services.AddTransient<Microsoft.AspNetCore.Hosting.IStartupFilter, RewriteRemoteIpStartupFilter>();
            });
        }
    }

    private sealed class RewriteRemoteIpStartupFilter : Microsoft.AspNetCore.Hosting.IStartupFilter
    {
        public Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> Configure(Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> next)
        {
            return app =>
            {
                // Runs as the *outermost* middleware (before forwarded headers
                // and auth) so the rewritten IP propagates through the entire
                // pipeline exactly as a real external request would.
                app.Use(async (HttpContext ctx, Func<Task> n) =>
                {
                    ctx.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.7");
                    await n();
                });
                next(app);
            };
        }
    }
}
