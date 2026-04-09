using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Middleware that protects /api/admin/* routes.
/// Requires authenticated user with IsAdmin = true.
/// </summary>
public class AdminAuthMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<AdminAuthMiddleware> _logger;

    public AdminAuthMiddleware(RequestDelegate next, ILogger<AdminAuthMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context, MosaicDbContext db)
    {
        // Only check admin routes
        if (!context.Request.Path.StartsWithSegments("/api/admin"))
        {
            await _next(context);
            return;
        }

        var authSub = context.Items["AuthSub"] as string;
        if (string.IsNullOrEmpty(authSub))
        {
            _logger.AdminAccessDenied(Guid.Empty, context.Request.Path.Value ?? "/api/admin");
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "Authentication required" });
            return;
        }

        // Reuse user loaded by CombinedAuthMiddleware when available
        var user = context.Items["AuthUser"] as User
            ?? await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            _logger.AdminAccessDenied(Guid.Empty, context.Request.Path.Value ?? "/api/admin");
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "User not found" });
            return;
        }

        if (!user.IsAdmin)
        {
            _logger.AdminAccessDenied(user.Id, context.Request.Path.Value ?? "/api/admin");
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "Admin privileges required" });
            return;
        }

        // Store admin user for controllers
        context.Items["AdminUser"] = user;

        await _next(context);
    }
}

public static class AdminAuthMiddlewareExtensions
{
    public static IApplicationBuilder UseAdminAuth(this IApplicationBuilder builder)
    {
        return builder.UseMiddleware<AdminAuthMiddleware>();
    }
}
