using System.Net;
using Mosaic.Backend.Tests.Helpers;

namespace Mosaic.Backend.Tests.Middleware;

public class TrustedProxyMiddlewareTests
{
    private readonly Mock<ILogger<TrustedProxyMiddleware>> _loggerMock = new();

    private TrustedProxyMiddleware CreateMiddleware(
        RequestDelegate next,
        Dictionary<string, string?>? configOverrides = null)
    {
        var config = TestConfigurationFactory.Create(configOverrides);
        return new TrustedProxyMiddleware(next, config, _loggerMock.Object);
    }

    [Fact]
    public async Task InvokeAsync_HealthEndpoint_AlwaysAllowed()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/health";
        // No Remote-User header, untrusted IP
        context.Connection.RemoteIpAddress = IPAddress.Parse("8.8.8.8");

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_NoRemoteIp_Returns401()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = null;

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.False(nextCalled);
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_UntrustedIp_Returns401()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.Parse("8.8.8.8"); // Not in trusted range
        context.Request.Headers["Remote-User"] = "valid-user";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.False(nextCalled);
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_TrustedIp_MissingRemoteUser_Returns401()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.Loopback; // 127.0.0.1 is trusted

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.False(nextCalled);
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_TrustedIp_EmptyRemoteUser_Returns401()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Request.Headers["Remote-User"] = "";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.False(nextCalled);
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Theory]
    [InlineData("user<script>")]
    [InlineData("user'or'1'='1")]
    [InlineData("user\nX-Inject: value")]
    [InlineData("user with spaces")]
    [InlineData("user;drop table users")]
    public async Task InvokeAsync_InvalidRemoteUserFormat_Returns400(string invalidUser)
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Request.Headers["Remote-User"] = invalidUser;

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.False(nextCalled);
        Assert.Equal(400, context.Response.StatusCode);
    }

    [Theory]
    [InlineData("valid-user")]
    [InlineData("user@domain.com")]
    [InlineData("user_name")]
    [InlineData("user.name")]
    [InlineData("CamelCaseUser")]
    [InlineData("user123")]
    public async Task InvokeAsync_ValidRemoteUser_SetsAuthSubAndCallsNext(string validUser)
    {
        // Arrange
        var nextCalled = false;
        string? capturedAuthSub = null;
        var middleware = CreateMiddleware(context =>
        {
            nextCalled = true;
            capturedAuthSub = context.Items["AuthSub"] as string;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Request.Headers["Remote-User"] = validUser;

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.True(nextCalled);
        Assert.Equal(validUser, capturedAuthSub);
    }

    [Fact]
    public async Task InvokeAsync_IPv6Loopback_IsTrusted()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.IPv6Loopback; // ::1
        context.Request.Headers["Remote-User"] = "test-user";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_UntrustedIp_RemovesRemoteUserHeader()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/users/me";
        context.Connection.RemoteIpAddress = IPAddress.Parse("8.8.8.8");
        context.Request.Headers["Remote-User"] = "malicious-user";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.False(nextCalled);
        Assert.False(context.Request.Headers.ContainsKey("Remote-User"));
    }

    [Fact]
    public async Task InvokeAsync_HealthSubPath_AlwaysAllowed()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/health/live";
        context.Connection.RemoteIpAddress = IPAddress.Parse("8.8.8.8"); // Untrusted

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_LocalhostInTrustedNetwork_IsTrusted()
    {
        // Arrange
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("127.0.0.2"); // In 127.0.0.0/8 range
        context.Request.Headers["Remote-User"] = "test-user";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.True(nextCalled);
    }
}
