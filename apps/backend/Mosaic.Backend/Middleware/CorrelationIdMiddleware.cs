using System.Text.RegularExpressions;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Middleware that generates or extracts correlation IDs for request tracing.
/// The correlation ID is added to response headers and stored in HttpContext.Items
/// for use in logging throughout the request lifecycle.
/// </summary>
public partial class CorrelationIdMiddleware
{
    private readonly RequestDelegate _next;
    private const string CorrelationIdHeader = "X-Correlation-Id";
    public const int MaxCorrelationIdLength = 128;

    // v1.0.2 s36: cap length and restrict charset on X-Correlation-Id.
    // Without this, an attacker could inject arbitrary characters (including
    // log-injection control bytes or near-unbounded strings) that would then
    // be echoed back in response headers and embedded in log scopes.
    private static readonly Regex ValidCorrelationId = ValidCorrelationIdRegex();

    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex ValidCorrelationIdRegex();

    public CorrelationIdMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Check if correlation ID was provided by client or upstream proxy
        var correlationId = context.Request.Headers[CorrelationIdHeader].FirstOrDefault();

        if (!string.IsNullOrEmpty(correlationId))
        {
            // v1.0.2 s36: reject malformed/oversized client-supplied IDs with 400.
            if (!ValidCorrelationId.IsMatch(correlationId))
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                context.Response.ContentType = "application/problem+json";
                await context.Response.WriteAsJsonAsync(new
                {
                    type = "about:blank",
                    title = "Invalid X-Correlation-Id",
                    status = StatusCodes.Status400BadRequest,
                    detail = $"X-Correlation-Id must match ^[A-Za-z0-9_-]{{1,{MaxCorrelationIdLength}}}$."
                });
                return;
            }
        }
        else
        {
            correlationId = Guid.NewGuid().ToString();
        }

        // Store in context for use by other middleware and controllers
        context.Items["CorrelationId"] = correlationId;

        // Add to response headers for client correlation
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[CorrelationIdHeader] = correlationId;
            return Task.CompletedTask;
        });

        await _next(context);
    }
}

/// <summary>
/// Extension methods for accessing correlation ID from HttpContext.
/// </summary>
public static class CorrelationIdExtensions
{
    public static string? GetCorrelationId(this HttpContext context)
    {
        return context.Items["CorrelationId"]?.ToString();
    }
}
