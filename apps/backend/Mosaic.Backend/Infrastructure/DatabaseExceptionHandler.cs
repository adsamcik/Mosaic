using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Middleware;

namespace Mosaic.Backend.Infrastructure;

/// <summary>
/// Global exception handler for database concurrency and constraint exceptions.
/// Converts DbUpdateConcurrencyException to 409 Conflict responses.
/// </summary>
public class DatabaseExceptionHandler : IExceptionHandler
{
    private readonly ILogger<DatabaseExceptionHandler> _logger;

    public DatabaseExceptionHandler(ILogger<DatabaseExceptionHandler> logger)
    {
        _logger = logger;
    }

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        if (exception is DbUpdateConcurrencyException concurrencyException)
        {
            _logger.LogWarning(
                "Concurrency conflict detected. Path: {Path}, Method: {Method}, CorrelationId: {CorrelationId}",
                httpContext.Request.Path,
                httpContext.Request.Method,
                httpContext.GetCorrelationId());

            httpContext.Response.StatusCode = StatusCodes.Status409Conflict;
            await httpContext.Response.WriteAsJsonAsync(new ProblemDetails
            {
                Status = StatusCodes.Status409Conflict,
                Title = "Conflict",
                Detail = "The resource was modified by another request. Please reload and try again.",
                Instance = httpContext.Request.Path
            }, cancellationToken);

            return true;
        }

        if (exception is DbUpdateException dbUpdateException)
        {
            var inner = dbUpdateException.InnerException?.Message ?? "";
            var isUniqueViolation = inner.Contains("unique", StringComparison.OrdinalIgnoreCase) ||
                                    inner.Contains("duplicate", StringComparison.OrdinalIgnoreCase);

            if (isUniqueViolation)
            {
                _logger.LogWarning(
                    "Unique constraint violation. Path: {Path}, Method: {Method}, CorrelationId: {CorrelationId}",
                    httpContext.Request.Path,
                    httpContext.Request.Method,
                    httpContext.GetCorrelationId());

                httpContext.Response.StatusCode = StatusCodes.Status409Conflict;
                await httpContext.Response.WriteAsJsonAsync(new ProblemDetails
                {
                    Status = StatusCodes.Status409Conflict,
                    Title = "Conflict",
                    Detail = "A resource with these values already exists.",
                    Instance = httpContext.Request.Path
                }, cancellationToken);

                return true;
            }
        }

        return false;
    }
}
