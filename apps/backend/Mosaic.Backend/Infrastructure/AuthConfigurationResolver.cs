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

        var trustedProxies =
            configuration.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];
        var parsedTrustedProxies = trustedProxies
            .Select(static configuredValue =>
            {
                var cidr = configuredValue?.Trim();
                if (string.IsNullOrEmpty(cidr)
                    || !System.Net.IPNetwork.TryParse(cidr, out var network))
                {
                    throw new InvalidOperationException(
                        $"Auth:TrustedProxies contains invalid CIDR '{configuredValue ?? "<null>"}'. " +
                        "Use an address and prefix length such as 10.0.0.5/32 or 10.0.0.0/24.");
                }

                return (ConfiguredValue: configuredValue, Network: network);
            })
            .ToArray();

        if (environment.IsProduction())
        {
            var unsafeNetworks = parsedTrustedProxies
                .Where(static configured => configured.Network.PrefixLength == 0)
                .Select(static configured => configured.ConfiguredValue)
                .ToArray();
            if (unsafeNetworks.Length > 0)
            {
                throw new InvalidOperationException(
                    "Auth:TrustedProxies must not contain an unrestricted network in Production. " +
                    $"Unsafe values: {string.Join(", ", unsafeNetworks)}. " +
                    "Trust only the exact reverse-proxy addresses.");
            }
        }

        var serverSecret = configuration["Auth:ServerSecret"];
        if (!environment.IsDevelopment() && string.IsNullOrWhiteSpace(serverSecret))
        {
            throw new InvalidOperationException(
                "Auth:ServerSecret is required outside Development. Set the configuration value " +
                "(e.g., via Auth__ServerSecret env var) to a stable secret of at least 32 random bytes.");
        }

        // When ServerSecret is present (any environment), it MUST be Base64-decodable
        // because AuthController.GenerateFakeSalt calls Convert.FromBase64String on it.
        // Failing fast at startup prevents a FormatException on the first /api/v1/auth/init
        // request for an unknown user.
        if (!string.IsNullOrWhiteSpace(serverSecret))
        {
            byte[] decoded;
            try
            {
                decoded = Convert.FromBase64String(serverSecret);
            }
            catch (FormatException ex)
            {
                throw new InvalidOperationException(
                    "Auth:ServerSecret must be a valid Base64-encoded value (e.g., the output of " +
                    "`openssl rand -base64 32`). The configured value could not be Base64-decoded.",
                    ex);
            }

            if (decoded.Length < 32)
            {
                throw new InvalidOperationException(
                    "Auth:ServerSecret must decode to at least 32 bytes of random data. " +
                    $"The configured value decoded to {decoded.Length} bytes.");
            }
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
