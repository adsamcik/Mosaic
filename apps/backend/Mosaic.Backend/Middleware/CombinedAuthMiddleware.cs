using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Data;
using Mosaic.Backend.Infrastructure;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Combined authentication middleware that supports both LocalAuth and ProxyAuth simultaneously.
/// LocalAuth uses session cookies, ProxyAuth trusts Remote-User header from reverse proxy.
/// When both are enabled, LocalAuth is tried first (via cookies), then ProxyAuth (via headers).
/// </summary>
public partial class CombinedAuthMiddleware
{
    private readonly RequestDelegate _next;
    private readonly bool _localAuthEnabled;
    private readonly bool _proxyAuthEnabled;
    private readonly List<IPNetwork> _trustedNetworks;
    private readonly bool _testSeedEnabled;
    private readonly IWebHostEnvironment _environment;
    private readonly ILogger<CombinedAuthMiddleware> _logger;

    // Session sliding window: 7 days
    private static readonly TimeSpan SessionSlidingExpiry = TimeSpan.FromDays(7);

    [GeneratedRegex(@"^[a-zA-Z0-9_\-@.]+$", RegexOptions.Compiled)]
    private static partial Regex ValidUserPattern();

    // Endpoints that don't require authentication
    private static readonly string[] PublicPaths =
    [
        "/health",
        "/api/v1/health",
        "/metrics",
        "/api/v1/auth/init",
        "/api/v1/auth/config",
        "/api/v1/auth/verify",
        "/api/v1/auth/register",
        "/api/v1/dev-auth",
        "/api/v1/s", // Intentionally broad for anonymous share-link routes; exact-plus-slash matching keeps /api/v1/settings and /api/v1/secrets private.
        "/api/v1/sidecar", // Sidecar Beacon signaling relay; intentionally unauthenticated (room-id is PAKE-derived, server cannot enumerate).
        "/swagger",
        "/openapi"
    ];

    public CombinedAuthMiddleware(
        RequestDelegate next,
        IConfiguration config,
        IWebHostEnvironment environment,
        ILogger<CombinedAuthMiddleware> logger)
    {
        _next = next;
        _logger = logger;
        _environment = environment;

        var authConfiguration = AuthConfigurationResolver.Resolve(config);
        _localAuthEnabled = authConfiguration.LocalAuthEnabled;
        _proxyAuthEnabled = authConfiguration.ProxyAuthEnabled;
        _testSeedEnabled = AuthConfigurationResolver.IsTestSeedEnabled(environment);

        // Parse trusted proxy networks
        var cidrs = config.GetSection("Auth:TrustedProxies").Get<string[]>() ?? [];
        _trustedNetworks = cidrs.Select(cidr => IPNetwork.Parse(cidr)).ToList();

        _logger.LogInformation(
            "CombinedAuthMiddleware initialized: LocalAuth={LocalAuth}, ProxyAuth={ProxyAuth}",
            _localAuthEnabled, _proxyAuthEnabled);
    }

    public async Task InvokeAsync(HttpContext context, MosaicDbContext db)
    {
        var path = context.Request.Path.Value ?? "";
        var isPublicPath = IsPublicPath(path);

        // Special case: /api/v1/auth/init returns 404 when LocalAuth is disabled
        if (isPublicPath &&
            AuthConfigurationResolver.MatchesPublicPath(path, "/api/v1/auth/init") &&
            !_localAuthEnabled)
        {
            context.Response.StatusCode = 404;
            context.Response.ContentType = "application/problem+json";
            var problem = new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "Not found",
                Detail = "Not found"
            };
            problem.Extensions["correlationId"] = context.GetCorrelationId();
            await context.Response.WriteAsJsonAsync(problem);
            return;
        }

        // Always attempt authentication to populate context items.
        // This enables public endpoints (e.g. /api/v1/auth/register) to
        // perform their own authorization checks when needed.
        var authenticated = false;
        if (_localAuthEnabled && await TryLocalAuthAsync(context, db))
        {
            authenticated = true;
        }
        else if (_proxyAuthEnabled && TryProxyAuth(context))
        {
            authenticated = true;
        }

        // Public paths proceed regardless of auth result
        if (isPublicPath)
        {
            await _next(context);
            return;
        }

        if (IsPublicShareLinkPhotoPath(context.Request))
        {
            await _next(context);
            return;
        }

        if (authenticated)
        {
            await _next(context);
            return;
        }

        // No valid authentication found
        context.Response.StatusCode = 401;
        context.Response.ContentType = "application/problem+json";
        var authProblem = new ProblemDetails
        {
            Status = StatusCodes.Status401Unauthorized,
            Title = "Authentication required",
            Detail = "Authentication required"
        };
        authProblem.Extensions["correlationId"] = context.GetCorrelationId();
        await context.Response.WriteAsJsonAsync(authProblem);
    }

    private async Task<bool> TryLocalAuthAsync(HttpContext context, MosaicDbContext db)
    {
        // Get session token from cookie
        if (!context.Request.Cookies.TryGetValue("mosaic_session", out var tokenBase64))
        {
            return false;
        }

        byte[] token;
        try
        {
            token = Convert.FromBase64String(tokenBase64);
        }
        catch
        {
            _logger.LogDebug("Invalid session cookie format");
            return false;
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
            _logger.LogDebug("Session not found or expired");
            return false;
        }

        // Check sliding expiration
        if (session.LastSeenAt < DateTime.UtcNow.Add(-SessionSlidingExpiry))
        {
            _logger.LogDebug("Session expired due to inactivity");
            return false;
        }

        // Update last seen (but not on every request - only if more than 1 minute since last update)
        if (session.LastSeenAt < DateTime.UtcNow.AddMinutes(-1))
        {
            session.LastSeenAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }

        RefreshSessionCookie(context, tokenBase64);

        // Set user identity in HttpContext
        context.Items["AuthSub"] = session.User.AuthSub;
        context.Items["UserId"] = session.UserId;
        context.Items["AuthMethod"] = "LocalAuth";
        context.Items["AuthUser"] = session.User;

        return true;
    }

    private void RefreshSessionCookie(HttpContext context, string tokenBase64)
    {
        if (context.Response.HasStarted)
        {
            return;
        }

        var isSecure = !_environment.IsDevelopment() &&
                       !_environment.EnvironmentName.Equals("Testing", StringComparison.OrdinalIgnoreCase);
        context.Response.Cookies.Append("mosaic_session", tokenBase64, new CookieOptions
        {
            HttpOnly = true,
            Secure = isSecure,
            SameSite = isSecure ? SameSiteMode.Strict : SameSiteMode.Lax,
            Path = "/api",
            MaxAge = SessionSlidingExpiry
        });
    }

    private bool TryProxyAuth(HttpContext context)
    {
        var remoteIp = context.Connection.RemoteIpAddress;
        if (remoteIp == null)
        {
            _logger.LogDebug("No remote IP address");
            return false;
        }

        // Check if request is from trusted proxy
        var isTrusted = _trustedNetworks.Any(network => network.Contains(remoteIp));
        if (!isTrusted)
        {
            _logger.LogDebug("Request from untrusted IP: {IP}", remoteIp);
            return false;
        }

        // Extract and validate Remote-User header
        var remoteUser = context.Request.Headers["Remote-User"].FirstOrDefault();
        if (string.IsNullOrEmpty(remoteUser))
        {
            return false;
        }

        if (!ValidUserPattern().IsMatch(remoteUser))
        {
            // SPEC-CrossPlatformHardening: never log raw Remote-User values.
            // Emit only coarse identifiers (length) for diagnostics.
            _logger.LogWarning("Invalid Remote-User format rejected (length: {Length})", remoteUser.Length);
            return false;
        }

        // Set user identity in HttpContext
        context.Items["AuthSub"] = remoteUser;
        context.Items["AuthMethod"] = "ProxyAuth";

        return true;
    }

    private bool IsPublicPath(string path)
    {
        foreach (var publicPath in PublicPaths)
        {
            if (AuthConfigurationResolver.MatchesPublicPath(path, publicPath))
            {
                return true;
            }
        }

        return _testSeedEnabled &&
               AuthConfigurationResolver.MatchesPublicPath(path, "/api/v1/test-seed");
    }

    private static bool IsPublicShareLinkPhotoPath(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        var path = request.Path.Value ?? string.Empty;
        return path.StartsWith("/api/v1/share-links/", StringComparison.OrdinalIgnoreCase)
            && path.EndsWith("/photos", StringComparison.OrdinalIgnoreCase);
    }
}
