using System.Security.Cryptography;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Moq;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class LocalAuthMiddlewareTests : IAsyncLifetime
{
    private MosaicDbContext _db = null!;
    private Mock<ILogger<LocalAuthMiddleware>> _logger = null!;

    public async Task InitializeAsync()
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase($"LocalAuthMiddleware_{Guid.NewGuid()}")
            .Options;
        _db = new MosaicDbContext(options);
        await _db.Database.EnsureCreatedAsync();
        _logger = new Mock<ILogger<LocalAuthMiddleware>>();
    }

    public Task DisposeAsync()
    {
        _db.Dispose();
        return Task.CompletedTask;
    }

    [Fact]
    public async Task AllowsHealthEndpoint_WithoutAuthentication()
    {
        // Arrange
        var nextCalled = false;
        RequestDelegate next = _ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        };

        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/health";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.True(nextCalled);
    }

    [Fact]
    public async Task AllowsDevAuthEndpoint_WithoutAuthentication()
    {
        // Arrange
        var nextCalled = false;
        RequestDelegate next = _ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        };

        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/dev-auth/login";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.True(nextCalled);
    }

    [Fact]
    public async Task Returns401_WhenNoCookie()
    {
        // Arrange
        RequestDelegate next = _ => Task.CompletedTask;
        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns401_WhenInvalidCookieFormat()
    {
        // Arrange
        RequestDelegate next = _ => Task.CompletedTask;
        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Request.Headers.Cookie = "mosaic_session=not-valid-base64!!!";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns401_WhenSessionNotFound()
    {
        // Arrange
        RequestDelegate next = _ => Task.CompletedTask;
        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var token = RandomNumberGenerator.GetBytes(32);
        var tokenBase64 = Convert.ToBase64String(token);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns401_WhenSessionUserIsNull()
    {
        // Arrange - Create session without proper user (simulating data integrity issue)
        var token = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(token);
        var tokenBase64 = Convert.ToBase64String(token);

        // Create a user first
        var user = new User
        {
            Id = Guid.NewGuid(),
            AuthSub = "testuser",
            IdentityPubkey = ""
        };
        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        // Create session pointing to this user
        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
            LastSeenAt = DateTime.UtcNow
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        // Now delete the user to simulate data integrity issue
        _db.Users.Remove(user);
        await _db.SaveChangesAsync();

        RequestDelegate next = _ => Task.CompletedTask;
        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert - Should return 401, not 500
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task SetsAuthSub_WhenValidSession()
    {
        // Arrange
        var token = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(token);
        var tokenBase64 = Convert.ToBase64String(token);

        var user = new User
        {
            Id = Guid.NewGuid(),
            AuthSub = "testuser",
            IdentityPubkey = ""
        };
        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
            LastSeenAt = DateTime.UtcNow
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        string? capturedAuthSub = null;
        Guid? capturedUserId = null;
        RequestDelegate next = ctx =>
        {
            capturedAuthSub = ctx.Items["AuthSub"] as string;
            capturedUserId = ctx.Items["UserId"] as Guid?;
            return Task.CompletedTask;
        };

        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.Equal("testuser", capturedAuthSub);
        Assert.Equal(user.Id, capturedUserId);
    }

    [Fact]
    public async Task Returns401_WhenSessionExpired()
    {
        // Arrange
        var token = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(token);
        var tokenBase64 = Convert.ToBase64String(token);

        var user = new User
        {
            Id = Guid.NewGuid(),
            AuthSub = "testuser",
            IdentityPubkey = ""
        };
        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTime.UtcNow.AddDays(-1), // Expired
            LastSeenAt = DateTime.UtcNow.AddDays(-1)
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        RequestDelegate next = _ => Task.CompletedTask;
        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns401_WhenSessionRevoked()
    {
        // Arrange
        var token = RandomNumberGenerator.GetBytes(32);
        var tokenHash = SHA256.HashData(token);
        var tokenBase64 = Convert.ToBase64String(token);

        var user = new User
        {
            Id = Guid.NewGuid(),
            AuthSub = "testuser",
            IdentityPubkey = ""
        };
        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
            LastSeenAt = DateTime.UtcNow,
            RevokedAt = DateTime.UtcNow // Revoked
        };
        _db.Sessions.Add(session);
        await _db.SaveChangesAsync();

        RequestDelegate next = _ => Task.CompletedTask;
        var middleware = new LocalAuthMiddleware(next, _logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        // Act
        await middleware.InvokeAsync(context, _db);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }
}
