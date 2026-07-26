using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Mosaic.Backend.Infrastructure;
using NSubstitute;
using Xunit;

namespace Mosaic.Backend.Tests.Infrastructure;

public class AuthConfigurationResolverTests
{
    [Fact]
    public void ValidateForStartup_Throws_WhenProductionServerSecretMissing()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true"
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("Auth:ServerSecret", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateForStartup_Throws_WhenStagingServerSecretMissing()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true"
        });

        var environment = CreateEnvironment("Staging");
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("Auth:ServerSecret is required outside Development", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateForStartup_AllowsDevelopmentServerSecretMissing()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true"
        });

        var environment = CreateEnvironment(Environments.Development);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Record.Exception(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Null(exception);
    }

    [Fact]
    public void ValidateForStartup_AllowsProductionServerSecretConfigured()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:ServerSecret"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Record.Exception(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Null(exception);
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    [InlineData("  0.0.0.0/0  ")]
    [InlineData("192.0.2.123/0")]
    [InlineData("2001:db8::1234/0")]
    public void ValidateForStartup_Throws_WhenProductionTrustsEveryAddress(string unsafeNetwork)
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:TrustedProxies:0"] = unsafeNetwork,
            ["Auth:ServerSecret"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("unrestricted network", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    public void ValidateForStartup_AllowsBroadTrustOnlyOutsideProduction(string network)
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:TrustedProxies:0"] = network
        });

        var environment = CreateEnvironment(Environments.Development);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Record.Exception(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Null(exception);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-cidr")]
    [InlineData("10.0.0.0/33")]
    [InlineData("2001:db8::/129")]
    public void ValidateForStartup_Throws_WhenTrustedProxyCidrIsInvalid(string invalidCidr)
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:TrustedProxies:0"] = invalidCidr
        });

        var environment = CreateEnvironment(Environments.Development);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("invalid CIDR", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ValidateForStartup_Throws_WhenDualModeEnabledWithoutExplicitOptIn()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "true",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:ServerSecret"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("Auth:AllowDualMode", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("not-base64-!@#$%^&*()_+abcdefgh")]
    [InlineData("====invalid====padding====chars=")]
    public void ValidateForStartup_Throws_WhenServerSecretIsNotBase64(string invalidSecret)
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:ServerSecret"] = invalidSecret
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("Base64", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ValidateForStartup_Throws_WhenServerSecretDecodesShorterThan32Bytes()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "false",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:ServerSecret"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("32 bytes", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ValidateForStartup_Throws_WhenDevelopmentServerSecretIsNotBase64()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "true",
            ["Auth:ProxyAuthEnabled"] = "false",
            ["Auth:ServerSecret"] = "this-is-not-base64-but-32-chars!"
        });

        var environment = CreateEnvironment(Environments.Development);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Assert.Throws<InvalidOperationException>(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Contains("Base64", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ValidateForStartup_AllowsDualModeWhenExplicitlyEnabled()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:LocalAuthEnabled"] = "true",
            ["Auth:ProxyAuthEnabled"] = "true",
            ["Auth:AllowDualMode"] = "true",
            ["Auth:ServerSecret"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        });

        var environment = CreateEnvironment(Environments.Production);
        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        var exception = Record.Exception(
            () => AuthConfigurationResolver.ValidateForStartup(configuration, environment, authConfiguration));

        Assert.Null(exception);
    }

    [Theory]
    [InlineData("LocalAuth", true, false)]
    [InlineData("ProxyAuth", false, true)]
    public void Resolve_UsesLegacyAuthMode_WhenExplicitFlagsAreUnset(
        string legacyMode,
        bool expectedLocalAuth,
        bool expectedProxyAuth)
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Auth:Mode"] = legacyMode
        });

        var authConfiguration = AuthConfigurationResolver.Resolve(configuration);

        Assert.Equal(expectedLocalAuth, authConfiguration.LocalAuthEnabled);
        Assert.Equal(expectedProxyAuth, authConfiguration.ProxyAuthEnabled);
        Assert.True(authConfiguration.UsesLegacyMode);
    }

    [Theory]
    [InlineData("/api/v1/auth/verify", "/api/v1/auth/verify", true)]
    [InlineData("/api/v1/auth/verify/", "/api/v1/auth/verify", true)]
    [InlineData("/api/v1/auth/verify-extra", "/api/v1/auth/verify", false)]
    [InlineData("/API/V1/AUTH/VERIFY", "/api/v1/auth/verify", true)]
    [InlineData("/api/v1/settings", "/api/v1/s", false)]
    [InlineData("/api/v1/secrets", "/api/v1/s", false)]
    [InlineData("/api/v1/s//keys", "/api/v1/s", true)]
    [InlineData("/api/v1/s?link=abc", "/api/v1/s", false)]
    [InlineData(null, "/api/v1/auth/verify", false)]
    [InlineData("", "/api/v1/auth/verify", false)]
    [InlineData("/api/v1/auth/verify", null, false)]
    [InlineData("/api/v1/auth/verify", "", false)]
    public void MatchesPublicPath_UsesExactOrSlashBoundaryMatching(
        string? path,
        string? publicPath,
        bool expectedMatch)
    {
        var matches = AuthConfigurationResolver.MatchesPublicPath(path, publicPath);

        Assert.Equal(expectedMatch, matches);
    }

    private static IConfiguration CreateConfiguration(IReadOnlyDictionary<string, string?> values)
    {
        return new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
    }

    private static IHostEnvironment CreateEnvironment(string environmentName)
    {
        var environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);
        return environment;
    }
}
