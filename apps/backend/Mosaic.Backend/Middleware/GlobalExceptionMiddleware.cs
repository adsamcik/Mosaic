using System.Net;
using System.Text.Json;
using Mosaic.Backend.Logging;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Global exception handler that catches unhandled exceptions,
/// logs them securely, and returns a generic error response.
/// Never exposes exception details to clients.
/// </summary>
public class GlobalExceptionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<GlobalExceptionMiddleware> _logger;

    public GlobalExceptionMiddleware(RequestDelegate next, ILogger<GlobalExceptionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            await HandleExceptionAsync(context, ex);
        }
    }

    private async Task HandleExceptionAsync(HttpContext context, Exception exception)
    {
        // Get correlation ID for log tracing (already in scope from LogScopeMiddleware)
        var correlationId = context.GetCorrelationId() ?? Guid.NewGuid().ToString();
        var path = context.Request.Path.Value ?? "/";

        // Log using high-performance source-generated logger
        _logger.UnhandledException(exception, exception.GetType().Name, path);

        // Return generic error to client - never expose exception details
        context.Response.StatusCode = (int)HttpStatusCode.InternalServerError;
        context.Response.ContentType = "application/json";

        var response = new
        {
            error = "An unexpected error occurred",
            correlationId = correlationId
        };

        var json = JsonSerializer.Serialize(response, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

        await context.Response.WriteAsync(json);
    }
}
