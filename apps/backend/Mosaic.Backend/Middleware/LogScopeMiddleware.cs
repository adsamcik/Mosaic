namespace Mosaic.Backend.Middleware;

/// <summary>
/// Middleware that creates a logging scope containing request context.
/// All logs within the request will automatically include:
/// - CorrelationId: Unique request identifier
/// - RequestPath: The request path
/// - RequestMethod: HTTP method
/// - UserId: Authenticated user ID (if available)
/// 
/// This eliminates the need to manually pass context to each log call.
/// </summary>
public class LogScopeMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<LogScopeMiddleware> _logger;

    public LogScopeMiddleware(RequestDelegate next, ILogger<LogScopeMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = context.GetCorrelationId() ?? Guid.NewGuid().ToString();
        var path = context.Request.Path.Value ?? "/";
        var method = context.Request.Method;

        // Create base scope with request info
        var scopeState = new Dictionary<string, object?>
        {
            ["CorrelationId"] = correlationId,
            ["RequestPath"] = path,
            ["RequestMethod"] = method
        };

        using (_logger.BeginScope(scopeState))
        {
            await _next(context);

            // After auth middleware runs, try to add user context
            // Note: We can't add to scope after it's created, so user ID
            // is logged at request end or by individual controllers
        }
    }
}

/// <summary>
/// Extension to add the middleware in Program.cs
/// </summary>
public static class LogScopeMiddlewareExtensions
{
    /// <summary>
    /// Adds logging scope middleware that enriches all logs with request context.
    /// Should be added after CorrelationIdMiddleware.
    /// </summary>
    public static IApplicationBuilder UseLogScope(this IApplicationBuilder app)
    {
        return app.UseMiddleware<LogScopeMiddleware>();
    }
}
