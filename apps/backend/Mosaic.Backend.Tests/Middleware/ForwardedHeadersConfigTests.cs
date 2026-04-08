using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

/// <summary>
/// Verifies that ForwardedHeadersOptions.KnownIPNetworks is correctly populated
/// from the Auth:TrustedProxies configuration, preventing X-Forwarded-For spoofing.
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
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

            var trustedProxies = config.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];
            foreach (var cidr in trustedProxies)
            {
                if (System.Net.IPNetwork.TryParse(cidr, out var network))
                {
                    options.KnownIPNetworks.Add(network);
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
    public void KnownIPNetworks_EmptyWhenNoTrustedProxies()
    {
        var baseline = BuildOptions(new Dictionary<string, string?>());
        var baselineCount = baseline.KnownIPNetworks.Count;

        // No additional networks should be added beyond defaults
        Assert.Equal(baselineCount, baseline.KnownIPNetworks.Count);
    }

    [Fact]
    public void KnownIPNetworks_SkipsInvalidCidrs()
    {
        var baseline = BuildOptions(new Dictionary<string, string?>());
        var baselineCount = baseline.KnownIPNetworks.Count;

        var opts = BuildOptions(new Dictionary<string, string?>
        {
            ["Auth:TrustedProxies:0"] = "192.168.1.0/24",
            ["Auth:TrustedProxies:1"] = "not-a-cidr",
            ["Auth:TrustedProxies:2"] = "::1/128",
        });

        // Only 2 valid CIDRs added on top of defaults
        Assert.Equal(baselineCount + 2, opts.KnownIPNetworks.Count);
        Assert.Contains(opts.KnownIPNetworks, n =>
            n.BaseAddress.ToString() == "192.168.1.0" && n.PrefixLength == 24);
        Assert.Contains(opts.KnownIPNetworks, n =>
            n.BaseAddress.ToString() == "::1" && n.PrefixLength == 128);
    }
}
