using Microsoft.Extensions.Hosting;

namespace Mosaic.Backend.Infrastructure;

internal sealed record ResolvedAuthConfiguration(
    bool LocalAuthEnabled,
    bool ProxyAuthEnabled,
    bool AllowDualMode,
    bool UsesLegacyMode);

internal static class AuthConfigurationResolver
{
    internal static ResolvedAuthConfiguration Resolve(IConfiguration configuration)
    {
        var legacyMode = configuration["Auth:Mode"];
        bool localAuthEnabled;
        bool proxyAuthEnabled;
        var usesLegacyMode = false;

        if (configuration.GetValue<bool?>("Auth:LocalAuthEnabled") is not null ||
            configuration.GetValue<bool?>("Auth:ProxyAuthEnabled") is not null)
        {
            localAuthEnabled = configuration.GetValue("Auth:LocalAuthEnabled", false);
            proxyAuthEnabled = configuration.GetValue("Auth:ProxyAuthEnabled", false);
        }
        else if (!string.IsNullOrWhiteSpace(legacyMode))
        {
            usesLegacyMode = true;
            localAuthEnabled = legacyMode.Equals("LocalAuth", StringComparison.OrdinalIgnoreCase);
            proxyAuthEnabled = legacyMode.Equals("ProxyAuth", StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            localAuthEnabled = false;
            proxyAuthEnabled = true;
        }

        return new ResolvedAuthConfiguration(
            localAuthEnabled,
            proxyAuthEnabled,
            configuration.GetValue("Auth:AllowDualMode", false),
            usesLegacyMode);
    }

    internal static void ValidateForStartup(
        IConfiguration configuration,
        IHostEnvironment environment,
        ResolvedAuthConfiguration authConfiguration)
    {
        if (authConfiguration.LocalAuthEnabled &&
            authConfiguration.ProxyAuthEnabled &&
            !authConfiguration.AllowDualMode)
        {
            throw new InvalidOperationException(
                "Both Auth:LocalAuthEnabled and Auth:ProxyAuthEnabled are enabled. " +
                "Set a single auth mode or explicitly opt in with Auth:AllowDualMode=true.");
        }

        if (environment.IsProduction() &&
            string.IsNullOrWhiteSpace(configuration["Auth:ServerSecret"]))
        {
            throw new InvalidOperationException(
                "Auth:ServerSecret must be configured in Production. " +
                "Refusing to start with an ephemeral fallback secret.");
        }
    }

    internal static bool IsTestSeedEnabled(IHostEnvironment environment)
    {
        return environment.IsDevelopment() || environment.IsEnvironment("Testing");
    }

    internal static bool MatchesPublicPath(string? path, string? publicPath)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(publicPath))
        {
            return false;
        }

        return path.Equals(publicPath, StringComparison.OrdinalIgnoreCase) ||
               (path.Length > publicPath.Length &&
                path.StartsWith(publicPath, StringComparison.OrdinalIgnoreCase) &&
                path[publicPath.Length] == '/');
    }
}
