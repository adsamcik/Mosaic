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
        "/api/test-seed/",  // E2E test seeding (dev/test environments only)
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
        var isPublicPath = IsPublicPath(path);

        // Always attempt authentication to populate context items.
        // This enables public endpoints to perform their own authorization checks.
        await TryAuthenticateAsync(context, db);

        // Public paths proceed regardless of auth result
        if (isPublicPath)
        {
            await _next(context);
            return;
        }

        // Non-public paths require successful authentication
        if (context.Items.ContainsKey("AuthSub"))
        {
            await _next(context);
            return;
        }

        context.Response.StatusCode = 401;
        await context.Response.WriteAsJsonAsync(new { error = "Authentication required" });
    }

    private async Task TryAuthenticateAsync(HttpContext context, MosaicDbContext db)
    {
        // Get session token from cookie
        if (!context.Request.Cookies.TryGetValue("mosaic_session", out var tokenBase64))
        {
            return;
        }

        byte[] token;
        try
        {
            token = Convert.FromBase64String(tokenBase64);
        }
        catch
        {
            _logger.LogDebug("Invalid session cookie format");
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

        if (session == null || session.User == null)
        {
            return;
        }

        // Check sliding expiration
        if (session.LastSeenAt < DateTime.UtcNow.Add(-SessionSlidingExpiry))
        {
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
