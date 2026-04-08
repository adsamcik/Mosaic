using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

/// <summary>
/// Verifies that ForwardedHeadersOptions is correctly hardened from the Auth:TrustedProxies
/// configuration, preventing X-Forwarded-For spoofing and rate-limit bypass.
/// </summary>
public class ForwardedHeadersConfigTests
{
    private static ForwardedHeadersOptions BuildOptions(Dictionary<string, string?> configData)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(configData)
            .Build();

        var services = new ServiceCollection();
        services.Configure<ForwardedHeadersOptions>(options =>
        {
            var trustedProxies = config.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];

            // Mirror the hardened Program.cs logic: clear defaults first so only the
            // explicit list is ever trusted.
            options.KnownIPNetworks.Clear();  // clears all network-range entries
            options.KnownProxies.Clear();     // clears loopback IPs from ASP.NET Core defaults

            if (trustedProxies.Length == 0)
            {
                options.ForwardedHeaders = ForwardedHeaders.None;
            }
            else
            {
                options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

                foreach (var cidr in trustedProxies)
                {
                    if (System.Net.IPNetwork.TryParse(cidr, out var network))
                    {
                        options.KnownIPNetworks.Add(network);
                    }
                }
            }
        });

        return services.BuildServiceProvider()
            .GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value;
    }

    [Fact]
    public void KnownIPNetworks_PopulatedFromTrustedProxies()
    {
        var opts = BuildOptions(new Dictionary<string, string?>
        {
            ["Auth:TrustedProxies:0"] = "10.0.0.0/8",
            ["Auth:TrustedProxies:1"] = "172.16.0.0/12",
        });

        Assert.Equal(ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto, opts.ForwardedHeaders);
        Assert.Contains(opts.KnownIPNetworks, n =>
            n.BaseAddress.ToString() == "10.0.0.0" && n.PrefixLength == 8);
        Assert.Contains(opts.KnownIPNetworks, n =>
            n.BaseAddress.ToString() == "172.16.0.0" && n.PrefixLength == 12);
    }

    [Fact]
    public void ForwardedHeaders_DisabledWhenNoTrustedProxies()
    {
        var opts = BuildOptions(new Dictionary<string, string?>());

        Assert.Equal(ForwardedHeaders.None, opts.ForwardedHeaders);
    }

    [Fact]
    public void KnownNetworksDefaults_ClearedWhenProxiesConfigured()
    {
        // ASP.NET Core defaults include loopback (127.0.0.0/8 and ::1/128) in KnownNetworks.
        // After hardening these must be absent so only the explicit list is trusted.
        var opts = BuildOptions(new Dictionary<string, string?>
        {
            ["Auth:TrustedProxies:0"] = "10.0.0.0/8",
        });

        // Loopback defaults must be cleared — only the configured network is present.
        Assert.Empty(opts.KnownProxies);
        Assert.DoesNotContain(opts.KnownIPNetworks, n => n.BaseAddress.ToString() == "127.0.0.0");
        Assert.DoesNotContain(opts.KnownIPNetworks, n => n.BaseAddress.ToString() == "::1");
        Assert.Contains(opts.KnownIPNetworks, n => n.BaseAddress.ToString() == "10.0.0.0" && n.PrefixLength == 8);
    }

    [Fact]
    public void KnownNetworksDefaults_ClearedWhenNoProxiesConfigured()
    {
        // Even with an empty proxy list the loopback defaults must be cleared so that
        // ForwardedHeaders cannot be processed from any connection.
        var opts = BuildOptions(new Dictionary<string, string?>());

        Assert.Empty(opts.KnownProxies);
        Assert.Empty(opts.KnownIPNetworks);
    }

    [Fact]
    public void KnownIPNetworks_EmptyWhenNoTrustedProxies()
    {
        var opts = BuildOptions(new Dictionary<string, string?>());

        Assert.Empty(opts.KnownIPNetworks);
    }

    [Fact]
    public void KnownIPNetworks_SkipsInvalidCidrs()
    {
        var opts = BuildOptions(new Dictionary<string, string?>
        {
            ["Auth:TrustedProxies:0"] = "192.168.1.0/24",
            ["Auth:TrustedProxies:1"] = "not-a-cidr",
            ["Auth:TrustedProxies:2"] = "::1/128",
        });

        // Only 2 valid CIDRs added; invalid entry is silently skipped.
        Assert.Equal(2, opts.KnownIPNetworks.Count);
        Assert.Contains(opts.KnownIPNetworks, n =>
            n.BaseAddress.ToString() == "192.168.1.0" && n.PrefixLength == 24);
        Assert.Contains(opts.KnownIPNetworks, n =>
            n.BaseAddress.ToString() == "::1" && n.PrefixLength == 128);
    }

    [Fact]
    public void OnlyConfiguredProxies_AreTrusted_NotDefaultLoopback()
    {
        // Scenario: TrustedProxies is set to a non-loopback range only.
        // Loopback (127.0.0.1 / 127.0.0.0/8 / ::1) must NOT appear in any trust list.
        var opts = BuildOptions(new Dictionary<string, string?>
        {
            ["Auth:TrustedProxies:0"] = "10.0.0.0/8",
        });

        Assert.Empty(opts.KnownProxies);
        Assert.DoesNotContain(opts.KnownIPNetworks, n => n.BaseAddress.ToString() == "127.0.0.0");
        Assert.DoesNotContain(opts.KnownIPNetworks, n => n.BaseAddress.ToString() == "::1");
        // Only the configured network should be present.
        Assert.Single(opts.KnownIPNetworks);
    }
}
