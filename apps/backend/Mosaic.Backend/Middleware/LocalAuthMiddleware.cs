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
#if DEBUG
        "/api/test-seed/",  // E2E test seeding (dev/test environments only)
#endif
        "/api/s/",  // Anonymous share link access
        "/swagger",
        "/openapi"
    ];

    /// <summary>
    /// Endpoints that MUST be processed anonymously — even if the caller
    /// presents a valid session cookie. These paths must never have an
    /// authenticated user identity attached to them, so that future
    /// request-scoped logging, tracing, or telemetry middleware cannot
    /// correlate visitor activity to a logged-in account.
    ///
    /// Visitor share-link routes (<c>/api/s/*</c>) are the canonical
    /// example: a visitor browser may also have a valid session cookie
    /// for the same origin, but the visitor surface is by design
    /// untied to user identity.
    /// </summary>
    private static readonly string[] AnonymousOnlyPaths =
    [
        "/api/s/",
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
        var isAnonymousOnly = IsAnonymousOnlyPath(path);
        var isPublicPath = isAnonymousOnly || IsPublicPath(path);

        // C5: Anonymous-only paths (visitor share links) MUST NOT be
        // associated with a user identity. Skip the cookie lookup entirely
        // so HttpContext.Items["AuthSub"] / ["UserId"] are never populated
        // for these requests. This guarantees that any request-logging,
        // tracing, audit, or telemetry middleware added later cannot
        // re-identify visitors who happen to also hold a valid session
        // cookie for the same origin.
        if (!isAnonymousOnly)
        {
            // Always attempt authentication to populate context items.
            // This enables public endpoints to perform their own authorization checks.
            await TryAuthenticateAsync(context, db);
        }

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

    private static bool IsAnonymousOnlyPath(string path)
    {
        foreach (var anonymousPath in AnonymousOnlyPaths)
        {
            if (path.StartsWith(anonymousPath, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }
}
