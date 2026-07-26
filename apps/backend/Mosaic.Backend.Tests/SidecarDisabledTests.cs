using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.SidecarSignaling;
using Xunit;

namespace Mosaic.Backend.Tests;

public sealed class SidecarDisabledTests : IDisposable
{
    private readonly DisabledFactory _factory = new();

    [Theory]
    [InlineData("/api/v1/sidecar/health")]
    [InlineData("/api/v1/sidecar/signal/00000000000000000000000000000000")]
    public async Task DisabledMode_DoesNotMapSidecarRoutes(string path)
    {
        using var client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false
        });

        using var response = await client.GetAsync(path);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public void DisabledMode_DoesNotAllocateRelayServices()
    {
        Assert.Null(_factory.Services.GetService<RoomManager>());
        Assert.Null(_factory.Services.GetService<SidecarRateLimiter>());
    }

    public void Dispose() => _factory.Dispose();

    private sealed class DisabledFactory : WebApplicationFactory<Program>
    {
        private readonly string _serverSecret =
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            // Minimal-host top-level service registration reads configuration
            // before ConfigureAppConfiguration callbacks run. Use host settings
            // as well so the off-by-default branch is selected deterministically.
            builder.UseSetting("Auth:ServerSecret", _serverSecret);
            builder.UseSetting("SidecarSignaling:Enabled", "false");
            builder.UseEnvironment("Testing");
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Auth:ServerSecret"] = _serverSecret,
                    ["SidecarSignaling:Enabled"] = "false"
                });
            });
        }
    }
}
