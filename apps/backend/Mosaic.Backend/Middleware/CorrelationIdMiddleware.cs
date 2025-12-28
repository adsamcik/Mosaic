namespace Mosaic.Backend.Middleware;

/// <summary>
/// Middleware that generates or extracts correlation IDs for request tracing.
/// The correlation ID is added to response headers and stored in HttpContext.Items
/// for use in logging throughout the request lifecycle.
/// </summary>
public class CorrelationIdMiddleware
{
    private readonly RequestDelegate _next;
    private const string CorrelationIdHeader = "X-Correlation-Id";

    public CorrelationIdMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Check if correlation ID was provided by client or upstream proxy
        var correlationId = context.Request.Headers[CorrelationIdHeader].FirstOrDefault();

        // Generate new one if not provided
        if (string.IsNullOrWhiteSpace(correlationId))
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
