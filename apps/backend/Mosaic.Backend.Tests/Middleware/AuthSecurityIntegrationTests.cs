using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Data;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Tests.Helpers;
using NSubstitute;
using System.Net;
using System.Security.Cryptography;
using Xunit;

namespace Mosaic.Backend.Tests.Middleware;

public class AuthSecurityIntegrationTests
{
    [Fact]
    public async Task VerifyHyphenatedRoute_IsNotPublic()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Production",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "false"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });

        using var db = TestDbContextFactory.Create();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/auth/verify-extra";

        await middleware.InvokeAsync(context, db);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
    }

    [Fact]
    public async Task TestSeed_IsNotPublic_InProduction()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Production",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "false"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });

        using var db = TestDbContextFactory.Create();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/test-seed/reset";

        await middleware.InvokeAsync(context, db);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
    }

    [Fact]
    public async Task TestSeed_Works_InTesting_WithoutAuthentication()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Testing",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "false"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });

        using var db = TestDbContextFactory.Create();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/test-seed/reset";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
    }

    [Fact]
    public async Task TestSeed_Works_InDevelopment_WithoutAuthentication()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Development",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "false"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });

        using var db = TestDbContextFactory.Create();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/test-seed/reset";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
    }

    [Fact]
    public async Task TusPatch_LocalAuth_RefreshesSlidingSessionCookie()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Testing",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "true",
                ["Auth:ProxyAuthEnabled"] = "false"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });

        await using var db = TestDbContextFactory.Create();
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "uploader@example.com",
            IdentityPubkey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        };
        var sessionToken = RandomNumberGenerator.GetBytes(32);
        db.Users.Add(user);
        db.Sessions.Add(new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            User = user,
            TokenHash = SHA256.HashData(sessionToken),
            LastSeenAt = DateTime.UtcNow.AddMinutes(-2),
            ExpiresAt = DateTime.UtcNow.AddDays(30)
        });
        await db.SaveChangesAsync();

        var tokenBase64 = Convert.ToBase64String(sessionToken);
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Patch;
        context.Request.Path = "/api/v1/files/shard-1";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
        var setCookie = Assert.Single(context.Response.Headers.SetCookie);
        Assert.Contains("mosaic_session=", setCookie);
        Assert.Contains("path=/api", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AuthenticatedApiRequest_WithRecentlySeenLocalSession_RefreshesSlidingSessionCookie()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Testing",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "true",
                ["Auth:ProxyAuthEnabled"] = "false"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });

        await using var db = TestDbContextFactory.Create();
        var user = new User
        {
            Id = Guid.CreateVersion7(),
            AuthSub = "active-uploader@example.com",
            IdentityPubkey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        };
        var sessionToken = RandomNumberGenerator.GetBytes(32);
        db.Users.Add(user);
        db.Sessions.Add(new Session
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            User = user,
            TokenHash = SHA256.HashData(sessionToken),
            LastSeenAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddDays(30)
        });
        await db.SaveChangesAsync();

        var tokenBase64 = Convert.ToBase64String(sessionToken);
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/v1/albums";
        context.Request.Headers.Cookie = $"mosaic_session={tokenBase64}";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
        var setCookie = Assert.Single(context.Response.Headers.SetCookie);
        Assert.Contains("mosaic_session=", setCookie);
        Assert.Contains("path=/api", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ProxyAuth_UsesCapturedSocketPeer_AfterForwardedClientIpRewrite()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Production",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "true",
                ["Auth:TrustedProxies:0"] = "10.0.0.0/8"
            },
            context =>
            {
                nextCalled = true;
                Assert.Equal("proxy-user@example.com", context.Items["AuthSub"]);
                return Task.CompletedTask;
            });
        using var db = TestDbContextFactory.Create();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("10.2.3.4");
        context.Request.Headers["Remote-User"] = "proxy-user@example.com";
        var capture = new SocketPeerCaptureMiddleware(async capturedContext =>
        {
            // Simulate ForwardedHeadersMiddleware replacing RemoteIpAddress
            // with the public client address after the socket peer was saved.
            capturedContext.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.27");
            await middleware.InvokeAsync(capturedContext, db);
        });

        await capture.InvokeAsync(context);

        Assert.True(nextCalled);
        Assert.Equal("ProxyAuth", context.Items["AuthMethod"]);
    }

    [Fact]
    public async Task ProxyAuth_RejectsSpoofedHeader_WhenCapturedSocketPeerIsUntrusted()
    {
        var nextCalled = false;
        var middleware = CreateMiddleware(
            "Production",
            new Dictionary<string, string?>
            {
                ["Auth:LocalAuthEnabled"] = "false",
                ["Auth:ProxyAuthEnabled"] = "true",
                ["Auth:TrustedProxies:0"] = "10.0.0.0/8"
            },
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });
        using var db = TestDbContextFactory.Create();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/albums";
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.12");
        context.Request.Headers["Remote-User"] = "spoofed-user@example.com";
        var capture = new SocketPeerCaptureMiddleware(async capturedContext =>
        {
            // Even a later trusted-looking rewritten address must not replace
            // the actual untrusted socket peer in the auth decision.
            capturedContext.Connection.RemoteIpAddress = IPAddress.Parse("10.9.8.7");
            await middleware.InvokeAsync(capturedContext, db);
        });

        await capture.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.False(context.Request.Headers.ContainsKey("Remote-User"));
        Assert.False(context.Items.ContainsKey("AuthSub"));
    }

    private static CombinedAuthMiddleware CreateMiddleware(
        string environmentName,
        IReadOnlyDictionary<string, string?> configurationValues,
        RequestDelegate next)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(configurationValues)
            .Build();

        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);

        var logger = Substitute.For<ILogger<CombinedAuthMiddleware>>();
        return new CombinedAuthMiddleware(next, configuration, environment, logger);
    }
}
