using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class AdminAuthMiddlewareTests
{
    private MosaicDbContext CreateDb()
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new MosaicDbContext(options);
    }

    [Fact]
    public async Task InvokeAsync_PassesThrough_WhenNotAdminRoute()
    {
        var db = CreateDb();
        var nextCalled = false;
        var middleware = new AdminAuthMiddleware(
            ctx => { nextCalled = true; return Task.CompletedTask; },
            NullLogger<AdminAuthMiddleware>.Instance);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_Returns401_WhenNoAuth()
    {
        var db = CreateDb();
        var middleware = new AdminAuthMiddleware(
            ctx => Task.CompletedTask,
            NullLogger<AdminAuthMiddleware>.Instance);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/admin/settings";
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context, db);

        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_Returns401_WhenUserNotFound()
    {
        var db = CreateDb();
        var middleware = new AdminAuthMiddleware(
            ctx => Task.CompletedTask,
            NullLogger<AdminAuthMiddleware>.Instance);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/admin/users";
        context.Items["AuthSub"] = "nonexistent@test.com";
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context, db);

        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_Returns403_WhenUserNotAdmin()
    {
        var db = CreateDb();
        db.Users.Add(new User
        {
            Id = Guid.NewGuid(),
            AuthSub = "regular@test.com",
            IdentityPubkey = "",
            IsAdmin = false
        });
        await db.SaveChangesAsync();

        var middleware = new AdminAuthMiddleware(
            ctx => Task.CompletedTask,
            NullLogger<AdminAuthMiddleware>.Instance);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/admin/albums";
        context.Items["AuthSub"] = "regular@test.com";
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context, db);

        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_SetsAdminUserAndContinues_WhenUserIsAdmin()
    {
        var db = CreateDb();
        var adminUser = new User
        {
            Id = Guid.NewGuid(),
            AuthSub = "admin@test.com",
            IdentityPubkey = "",
            IsAdmin = true
        };
        db.Users.Add(adminUser);
        await db.SaveChangesAsync();

        var nextCalled = false;
        var middleware = new AdminAuthMiddleware(
            ctx => { nextCalled = true; return Task.CompletedTask; },
            NullLogger<AdminAuthMiddleware>.Instance);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/admin/stats";
        context.Items["AuthSub"] = "admin@test.com";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
        Assert.NotNull(context.Items["AdminUser"]);
        Assert.Equal(adminUser.Id, ((User)context.Items["AdminUser"]!).Id);
    }
}
