using System.Net;
using System.Text.RegularExpressions;

namespace Mosaic.Backend.Middleware;

public partial class TrustedProxyMiddleware
{
    private readonly RequestDelegate _next;
    private readonly List<IPNetwork> _trustedNetworks;
    private readonly ILogger<TrustedProxyMiddleware> _logger;

    [GeneratedRegex(@"^[a-zA-Z0-9_\-@.]+$", RegexOptions.Compiled)]
    private static partial Regex ValidUserPattern();

    public TrustedProxyMiddleware(
        RequestDelegate next,
        IConfiguration config,
        ILogger<TrustedProxyMiddleware> logger)
    {
        _next = next;
        _logger = logger;

        var cidrs = config.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];
        _trustedNetworks = cidrs.Select(cidr => IPNetwork.Parse(cidr)).ToList();
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Public endpoints that don't require authentication
        if (context.Request.Path.StartsWithSegments("/health") ||
            context.Request.Path.StartsWithSegments("/api/s") ||
            context.Request.Path.StartsWithSegments("/api/auth/init"))
        {
            // Return 404 for auth/init in ProxyAuth mode - endpoint doesn't exist
            if (context.Request.Path.StartsWithSegments("/api/auth/init"))
            {
                context.Response.StatusCode = 404;
                await context.Response.WriteAsJsonAsync(new { error = "Not found" });
                return;
            }
            await _next(context);
            return;
        }

        var remoteIp = context.Connection.RemoteIpAddress;
        if (remoteIp == null)
        {
            context.Response.StatusCode = 401;
            return;
        }

        // Check if request is from trusted proxy
        var isTrusted = _trustedNetworks.Any(network => network.Contains(remoteIp));

        if (!isTrusted)
        {
            _logger.LogWarning("Request from untrusted IP: {IP}", remoteIp);
            context.Request.Headers.Remove("Remote-User");
            context.Response.StatusCode = 401;
            return;
        }

        // Extract and validate Remote-User header
        var remoteUser = context.Request.Headers["Remote-User"].FirstOrDefault();

        if (string.IsNullOrEmpty(remoteUser))
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = "Missing Remote-User header" });
            return;
        }

        if (!ValidUserPattern().IsMatch(remoteUser))
        {
            context.Response.StatusCode = 400;
            await context.Response.WriteAsJsonAsync(new { error = "Invalid Remote-User format" });
            return;
        }

        // Store in HttpContext for controllers
        context.Items["AuthSub"] = remoteUser;

        await _next(context);
    }
}
