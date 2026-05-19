using System.Net;
using Microsoft.Extensions.Hosting;
using Mosaic.Backend.Infrastructure;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Reject cross-origin state-changing requests (POST / PUT / PATCH /
/// DELETE) by validating <c>Sec-Fetch-Site</c> and <c>Origin</c>.
///
/// Audit "threat-model C-1": Mosaic ships no anti-CSRF token and relies
/// on the cookie's <c>SameSite=Strict</c> attribute. SameSite is a strong
/// default but it is NOT a substitute for proper CSRF protection when:
///   - the deployment uses <c>ProxyAuth</c> (Authelia / similar). The
///     reverse proxy attaches the <c>Remote-User</c> header to whatever
///     request the SSO session can prove ownership of — including
///     requests issued cross-origin via <c>fetch(..., credentials:
///     'include')</c> from an evil page. SameSite never sees those
///     requests.
///   - SameSite is browser-side and a buggy / non-default cookie policy
///     could weaken it without us noticing.
///
/// This middleware enforces a second, server-side check:
///   - <c>Sec-Fetch-Site</c> (Fetch Metadata Request Headers) must be
///     either <c>same-origin</c> or <c>none</c> (direct address-bar
///     navigation) for state-changing methods. <c>cross-site</c> and
///     <c>same-site</c> are rejected with <c>403</c>.
///   - For browsers that don't send <c>Sec-Fetch-Site</c> (legacy
///     desktop Safari before ~16) we fall back to comparing the
///     <c>Origin</c> header against the request <c>Host</c>. Missing
///     <c>Origin</c> on a state-changing request is treated as
///     suspicious and rejected.
///
/// Safe (read-only) methods are passed through unchanged because they
/// are also gated by app-level authorization and bypassing them with a
/// cross-origin GET would only reveal information the user already
/// holds.
///
/// Exempt paths:
///   - <c>/api/v1/auth/init</c> and <c>/api/v1/auth/verify</c> — login flow
///     bootstraps cross-origin metadata before any cookie exists. They
///     are guarded by the per-IP rate limiter and PAKE.
///   - <c>/api/v1/sidecar/*</c> — sidecar relay WebSocket; no cookies, no
///     CSRF surface.
///   - <c>/api/v1/s/*</c> — anonymous share-link surface; no cookies in
///     play (the visitor side ships with `credentials: 'omit'` in
///     practice, and the server is anonymous-only per the LocalAuth
///     middleware).
///
/// On rejection: HTTP <c>403 Forbidden</c> with a stable, opaque body
/// so a probing page cannot tell whether the route exists.
/// </summary>
public sealed class OriginValidationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<OriginValidationMiddleware> _logger;
    private readonly string[] _exemptPathPrefixes;
    private readonly bool _allowHeaderlessRequests;

    private static readonly string[] BaseExemptPathPrefixes =
    {
        "/api/v1/auth/init",
        "/api/v1/auth/verify",
        "/api/v1/auth/register",
        "/api/v1/sidecar/",
        "/api/v1/s/",
        "/health",
        "/api/v1/health",
    };

    /// <summary>
    /// E2E test-seed endpoints are called by out-of-browser tooling
    /// (Node's <c>fetch</c>, curl, Playwright global-setup) that does not
    /// emit <c>Sec-Fetch-Site</c> or <c>Origin</c> headers. They are
    /// exempted from origin validation, but ONLY when the host
    /// environment also enables the test-seed controller — i.e.
    /// <c>Development</c> or <c>Testing</c>. In <c>Production</c> the
    /// path is NOT exempt and the controller itself is gated to 404 by
    /// <see cref="AuthConfigurationResolver.IsTestSeedEnabled"/>.
    /// </summary>
    private const string TestSeedPathPrefix = "/api/v1/test-seed/";

    private static readonly HashSet<string> SafeMethods = new(StringComparer.OrdinalIgnoreCase)
    {
        HttpMethods.Get,
        HttpMethods.Head,
        HttpMethods.Options,
        HttpMethods.Trace,
    };

    public OriginValidationMiddleware(
        RequestDelegate next,
        ILogger<OriginValidationMiddleware> logger,
        IHostEnvironment environment)
    {
        _next = next;
        _logger = logger;

        if (AuthConfigurationResolver.IsTestSeedEnabled(environment))
        {
            _exemptPathPrefixes = new string[BaseExemptPathPrefixes.Length + 1];
            Array.Copy(BaseExemptPathPrefixes, _exemptPathPrefixes, BaseExemptPathPrefixes.Length);
            _exemptPathPrefixes[BaseExemptPathPrefixes.Length] = TestSeedPathPrefix;
        }
        else
        {
            _exemptPathPrefixes = BaseExemptPathPrefixes;
        }

        // v1.0.x album-create-403: E2E pool fixtures (Playwright global-setup,
        // test-data-factory) hit state-changing endpoints like
        // POST /api/v1/albums from Node's bare `fetch`, which emits neither
        // Sec-Fetch-Site nor Origin. The CSRF protection rationale (audit
        // threat-model C-1) targets cross-site browser navigations carrying
        // ambient credentials — non-browser tooling cannot mount a CSRF
        // attack because there is no ambient browser session. In
        // Development / Testing we therefore treat completely header-less
        // state-changing requests as trusted tooling. In Production the
        // strict rejection is preserved (a real browser ALWAYS sets at
        // least Sec-Fetch-Site or Origin on POST/PUT/PATCH/DELETE).
        _allowHeaderlessRequests =
            environment.IsDevelopment() ||
            environment.IsEnvironment("Testing");
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (SafeMethods.Contains(context.Request.Method))
        {
            await _next(context);
            return;
        }

        var path = context.Request.Path.Value ?? string.Empty;
        if (IsExempt(path, _exemptPathPrefixes))
        {
            await _next(context);
            return;
        }

        // Prefer Sec-Fetch-Site when present (Chromium/Firefox >=90,
        // Safari >=16.4). Values are well-defined; we accept only the
        // explicitly safe ones.
        var secFetchSite = context.Request.Headers["Sec-Fetch-Site"].ToString();
        if (!string.IsNullOrEmpty(secFetchSite))
        {
            if (string.Equals(secFetchSite, "same-origin", StringComparison.OrdinalIgnoreCase)
                || string.Equals(secFetchSite, "none", StringComparison.OrdinalIgnoreCase))
            {
                await _next(context);
                return;
            }

            _logger.LogWarning(
                "Rejected state-changing request from {SecFetchSite} for path template {PathPrefix}",
                secFetchSite,
                PathPrefix(path));
            await RejectAsync(context);
            return;
        }

        // No Sec-Fetch-Site header. Fall back to Origin/Host comparison.
        // A state-changing request with no Origin header is rejected
        // (legitimate browser usage always sets Origin for non-safe
        // methods); same-origin Origin is accepted.
        var origin = context.Request.Headers["Origin"].ToString();
        if (string.IsNullOrEmpty(origin))
        {
            // Dev/Testing only: header-less requests (no Sec-Fetch-Site
            // AND no Origin) originate from non-browser E2E tooling
            // (Node fetch, curl, Playwright global-setup). They cannot
            // be CSRF — there is no ambient browser session attached.
            // See ctor for the full rationale.
            if (_allowHeaderlessRequests)
            {
                await _next(context);
                return;
            }

            _logger.LogWarning(
                "Rejected state-changing request without Sec-Fetch-Site or Origin header for path template {PathPrefix}",
                PathPrefix(path));
            await RejectAsync(context);
            return;
        }

        if (!TryParseHost(origin, out var originHost))
        {
            _logger.LogWarning(
                "Rejected state-changing request with malformed Origin header for path template {PathPrefix}",
                PathPrefix(path));
            await RejectAsync(context);
            return;
        }

        var requestHost = context.Request.Host.Host;
        if (string.IsNullOrEmpty(requestHost))
        {
            _logger.LogWarning(
                "Rejected state-changing request with empty Host header for path template {PathPrefix}",
                PathPrefix(path));
            await RejectAsync(context);
            return;
        }

        if (string.Equals(originHost, requestHost, StringComparison.OrdinalIgnoreCase))
        {
            await _next(context);
            return;
        }

        _logger.LogWarning(
            "Rejected cross-origin state-changing request for path template {PathPrefix}",
            PathPrefix(path));
        await RejectAsync(context);
    }

    private static bool IsExempt(string path, string[] exemptPathPrefixes)
    {
        foreach (var prefix in exemptPathPrefixes)
        {
            if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static bool TryParseHost(string origin, out string host)
    {
        host = string.Empty;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
        {
            return false;
        }
        host = uri.Host;
        return !string.IsNullOrEmpty(host);
    }

    private static string PathPrefix(string path)
    {
        // Redact resource IDs from the log line — only the route
        // template prefix is supportable / non-sensitive.
        var firstSegments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (firstSegments.Length >= 2)
        {
            return $"/{firstSegments[0]}/{firstSegments[1]}";
        }
        return path;
    }

    private static async Task RejectAsync(HttpContext context)
    {
        context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
        await context.Response.WriteAsJsonAsync(new { error = "Forbidden" });
    }
}
