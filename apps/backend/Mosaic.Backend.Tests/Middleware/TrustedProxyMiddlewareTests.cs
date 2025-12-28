using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Moq;
using Mosaic.Backend.Middleware;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class TrustedProxyMiddlewareTests
{
    private static IConfiguration CreateConfig(params string[] trustedCidrs)
    {
        var configData = new Dictionary<string, string?>();
        for (int i = 0; i < trustedCidrs.Length; i++)
        {
            configData[$"Auth:TrustedProxies:{i}"] = trustedCidrs[i];
        }

        return new ConfigurationBuilder()
            .AddInMemoryCollection(configData)
            .Build();
    }

    private static Mock<ILogger<TrustedProxyMiddleware>> CreateLogger()
    {
        return new Mock<ILogger<TrustedProxyMiddleware>>();
    }

    [Fact]
    public async Task AllowsHealthEndpoint_WithoutAuthentication()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();
        var nextCalled = false;

        RequestDelegate next = _ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        };

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/health";
        context.Connection.RemoteIpAddress = IPAddress.Parse("192.168.1.1"); // Not trusted

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.True(nextCalled);
    }

    [Fact]
    public async Task Returns401_WhenRemoteIpNull()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        RequestDelegate next = _ => Task.CompletedTask;

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = null;

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns401_WhenIpNotTrusted()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        RequestDelegate next = _ => Task.CompletedTask;

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("192.168.1.1"); // Not in 10.0.0.0/8

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns401_WhenRemoteUserMissing()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        RequestDelegate next = _ => Task.CompletedTask;

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.1"); // Trusted
        // No Remote-User header

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
    }

    [Fact]
    public async Task Returns400_WhenRemoteUserInvalid()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        RequestDelegate next = _ => Task.CompletedTask;

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.1"); // Trusted
        context.Request.Headers["Remote-User"] = "invalid user with spaces!@#$%"; // Invalid chars

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal(400, context.Response.StatusCode);
    }

    [Fact]
    public async Task SetsAuthSub_WhenValidRequest()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();
        string? authSub = null;

        RequestDelegate next = ctx =>
        {
            authSub = ctx.Items["AuthSub"] as string;
            return Task.CompletedTask;
        };

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.1"); // Trusted
        context.Request.Headers["Remote-User"] = "test-user-123";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal("test-user-123", authSub);
    }

    [Fact]
    public async Task AcceptsValidRemoteUserFormats()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        var validUsernames = new[]
        {
            "user123",
            "test-user",
            "test_user",
            "user@domain.com",
            "user.name",
            "User123"
        };

        foreach (var username in validUsernames)
        {
            string? authSub = null;

            RequestDelegate next = ctx =>
            {
                authSub = ctx.Items["AuthSub"] as string;
                return Task.CompletedTask;
            };

            var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

            var context = new DefaultHttpContext();
            context.Request.Path = "/api/albums";
            context.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.1");
            context.Request.Headers["Remote-User"] = username;

            // Act
            await middleware.InvokeAsync(context);

            // Assert
            Assert.Equal(username, authSub);
        }
    }

    [Fact]
    public async Task RejectsInvalidRemoteUserFormats()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        var invalidUsernames = new[]
        {
            "user with spaces",
            "user<script>",
            "user\nname",
            "user;drop table",
            ""
        };

        foreach (var username in invalidUsernames)
        {
            RequestDelegate next = _ => Task.CompletedTask;

            var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

            var context = new DefaultHttpContext();
            context.Request.Path = "/api/albums";
            context.Connection.RemoteIpAddress = IPAddress.Parse("10.0.0.1");
            context.Request.Headers["Remote-User"] = username;

            // Act
            await middleware.InvokeAsync(context);

            // Assert
            Assert.True(context.Response.StatusCode == 400 || context.Response.StatusCode == 401,
                $"Expected 400 or 401 for username '{username}', got {context.Response.StatusCode}");
        }
    }

    [Fact]
    public async Task SupportMultipleTrustedNetworks()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16");
        var logger = CreateLogger();

        var trustedIps = new[]
        {
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1"
        };

        foreach (var ip in trustedIps)
        {
            string? authSub = null;

            RequestDelegate next = ctx =>
            {
                authSub = ctx.Items["AuthSub"] as string;
                return Task.CompletedTask;
            };

            var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

            var context = new DefaultHttpContext();
            context.Request.Path = "/api/albums";
            context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
            context.Request.Headers["Remote-User"] = "test-user";

            // Act
            await middleware.InvokeAsync(context);

            // Assert
            Assert.Equal("test-user", authSub);
        }
    }

    [Fact]
    public async Task RemovesRemoteUserHeader_WhenNotTrusted()
    {
        // Arrange
        var config = CreateConfig("10.0.0.0/8");
        var logger = CreateLogger();

        RequestDelegate next = _ => Task.CompletedTask;

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("192.168.1.1"); // Not trusted
        context.Request.Headers["Remote-User"] = "malicious-user"; // Attempt to spoof

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal(401, context.Response.StatusCode);
        Assert.False(context.Request.Headers.ContainsKey("Remote-User"));
    }

    [Fact]
    public async Task WorksWithLocalhostIPv4()
    {
        // Arrange
        var config = CreateConfig("127.0.0.0/8");
        var logger = CreateLogger();
        string? authSub = null;

        RequestDelegate next = ctx =>
        {
            authSub = ctx.Items["AuthSub"] as string;
            return Task.CompletedTask;
        };

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("127.0.0.1");
        context.Request.Headers["Remote-User"] = "localhost-user";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal("localhost-user", authSub);
    }

    [Fact]
    public async Task WorksWithIPv6Localhost()
    {
        // Arrange
        var config = CreateConfig("::1/128");
        var logger = CreateLogger();
        string? authSub = null;

        RequestDelegate next = ctx =>
        {
            authSub = ctx.Items["AuthSub"] as string;
            return Task.CompletedTask;
        };

        var middleware = new TrustedProxyMiddleware(next, config, logger.Object);

        var context = new DefaultHttpContext();
        context.Request.Path = "/api/albums";
        context.Connection.RemoteIpAddress = IPAddress.IPv6Loopback;
        context.Request.Headers["Remote-User"] = "ipv6-user";

        // Act
        await middleware.InvokeAsync(context);

        // Assert
        Assert.Equal("ipv6-user", authSub);
    }
}
