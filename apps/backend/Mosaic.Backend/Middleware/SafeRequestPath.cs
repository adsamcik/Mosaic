using Microsoft.AspNetCore.Routing;

namespace Mosaic.Backend.Middleware;

/// <summary>Returns route templates for logs and redacts object identifiers when routing metadata is unavailable.</summary>
internal static class SafeRequestPath
{
    private static readonly string[] SensitivePrefixes =
    [
        "/api/v1/s",
        "/api/v1/albums",
        "/api/v1/manifests",
        "/api/v1/shards",
        "/api/v1/share-links",
        "/api/v1/files",
        "/api/v1/tiles",
        "/api/v1/sidecar/signal",
        "/s"
    ];

    internal static string ForLogging(HttpContext context)
    {
        if (context.GetEndpoint() is RouteEndpoint routeEndpoint &&
            !string.IsNullOrWhiteSpace(routeEndpoint.RoutePattern.RawText))
        {
            var template = routeEndpoint.RoutePattern.RawText!;
            return template.StartsWith('/') ? template : "/" + template;
        }

        return Redact(context.Request.Path.Value);
    }

    internal static string Redact(string? path)
    {
        var value = string.IsNullOrWhiteSpace(path) ? "/" : path;
        foreach (var prefix in SensitivePrefixes)
        {
            if (value.Equals(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return prefix;
            }

            if (value.Length > prefix.Length &&
                value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
                value[prefix.Length] == '/')
            {
                return prefix + "/{redacted}";
            }
        }

        return value;
    }
}
