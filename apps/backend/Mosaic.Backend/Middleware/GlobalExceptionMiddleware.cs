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

        // Determine appropriate status code based on exception type
        var statusCode = exception switch
        {
            UnauthorizedAccessException => HttpStatusCode.Unauthorized,
            _ => HttpStatusCode.InternalServerError
        };

        // Log ALL exceptions during development for debugging
        _logger.LogError(exception,
            "Exception in {Path}: {ExceptionType} - {Message}",
            path, exception.GetType().Name, exception.Message);

        // Return generic error to client - never expose exception details
        context.Response.StatusCode = (int)statusCode;
        context.Response.ContentType = "application/json";

        var response = new
        {
            error = statusCode == HttpStatusCode.Unauthorized
                ? "Authentication required"
                : "An unexpected error occurred",
            correlationId = correlationId
        };

        var json = JsonSerializer.Serialize(response, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

        await context.Response.WriteAsync(json);
    }
}
