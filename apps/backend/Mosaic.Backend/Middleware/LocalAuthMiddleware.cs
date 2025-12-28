using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Middleware for local authentication mode.
/// Validates session cookies and sets user identity.
/// This is an alternative to TrustedProxyMiddleware for deployments without external auth.
/// </summary>
public class LocalAuthMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<LocalAuthMiddleware> _logger;

    // Session sliding window: 7 days
    private static readonly TimeSpan SessionSlidingExpiry = TimeSpan.FromDays(7);

    // Endpoints that don't require authentication
    private static readonly string[] PublicPaths =
    [
        "/health",
        "/api/health",
        "/api/auth/init",
        "/api/auth/verify",
        "/api/auth/register",
        "/api/dev-auth/",  // Development-only quick login
        "/api/s/",  // Anonymous share link access
        "/swagger",
        "/openapi"
    ];

    public LocalAuthMiddleware(
        RequestDelegate next,
        ILogger<LocalAuthMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context, MosaicDbContext db)
    {
        var path = context.Request.Path.Value ?? "";

        // Check if path is public
        if (IsPublicPath(path))
        {
            await _next(context);
            return;
        }

        // Get session token from cookie
        if (!context.Request.Cookies.TryGetValue("mosaic_session", out var tokenBase64))
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = "Authentication required" });
            return;
        }

        byte[] token;
        try
        {
            token = Convert.FromBase64String(tokenBase64);
        }
        catch
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = "Invalid session" });
            return;
        }

        // Look up session by token hash
        var tokenHash = SHA256.HashData(token);
        var session = await db.Sessions
            .Include(s => s.User)
            .FirstOrDefaultAsync(s =>
                s.TokenHash == tokenHash &&
                s.RevokedAt == null &&
                s.ExpiresAt > DateTime.UtcNow);

        if (session == null)
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = "Session expired or invalid" });
            return;
        }

        // Check sliding expiration
        if (session.LastSeenAt < DateTime.UtcNow.Add(-SessionSlidingExpiry))
        {
            context.Response.StatusCode = 401;
            await context.Response.WriteAsJsonAsync(new { error = "Session expired due to inactivity" });
            return;
        }

        // Update last seen (but not on every request - only if more than 1 minute since last update)
        if (session.LastSeenAt < DateTime.UtcNow.AddMinutes(-1))
        {
            session.LastSeenAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }

        // Set user identity in HttpContext (same format as TrustedProxyMiddleware)
        context.Items["AuthSub"] = session.User.AuthSub;
        context.Items["UserId"] = session.UserId;

        await _next(context);
    }

    private static bool IsPublicPath(string path)
    {
        foreach (var publicPath in PublicPaths)
        {
            if (path.StartsWith(publicPath, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }
}
