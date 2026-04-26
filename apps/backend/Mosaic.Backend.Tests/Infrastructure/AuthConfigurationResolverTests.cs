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
    [InlineData("/api/auth/verify", "/api/auth/verify", true)]
    [InlineData("/api/auth/verify/", "/api/auth/verify", true)]
    [InlineData("/api/auth/verify-extra", "/api/auth/verify", false)]
    [InlineData("/API/AUTH/VERIFY", "/api/auth/verify", true)]
    [InlineData("/api/settings", "/api/s", false)]
    [InlineData("/api/secrets", "/api/s", false)]
    [InlineData("/api/s//keys", "/api/s", true)]
    [InlineData("/api/s?link=abc", "/api/s", false)]
    [InlineData(null, "/api/auth/verify", false)]
    [InlineData("", "/api/auth/verify", false)]
    [InlineData("/api/auth/verify", null, false)]
    [InlineData("/api/auth/verify", "", false)]
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
