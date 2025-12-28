using System.Diagnostics;
using Mosaic.Backend.Logging;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Middleware that logs request timing using high-performance LoggerMessage.
/// Logs at Information level for successful requests (2xx/3xx),
/// and Warning level for client/server errors (4xx/5xx).
/// </summary>
public class RequestTimingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RequestTimingMiddleware> _logger;

    public RequestTimingMiddleware(RequestDelegate next, ILogger<RequestTimingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var stopwatch = Stopwatch.StartNew();

        try
        {
            await _next(context);
        }
        finally
        {
            stopwatch.Stop();
            var elapsed = stopwatch.ElapsedMilliseconds;
            var method = context.Request.Method;
            var path = context.Request.Path.Value ?? "/";
            var statusCode = context.Response.StatusCode;

            // Use appropriate log level based on status code
            if (statusCode >= 400)
            {
                _logger.RequestFailed(method, path, statusCode, elapsed);
            }
            else
            {
                _logger.RequestCompleted(method, path, statusCode, elapsed);
            }
        }
    }
}
