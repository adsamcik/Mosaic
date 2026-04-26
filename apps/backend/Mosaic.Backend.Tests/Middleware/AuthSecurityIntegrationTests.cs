using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Data;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Tests.Helpers;
using NSubstitute;
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
        context.Request.Path = "/api/auth/verify-extra";

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
        context.Request.Path = "/api/test-seed/reset";

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
        context.Request.Path = "/api/test-seed/reset";

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
        context.Request.Path = "/api/test-seed/reset";

        await middleware.InvokeAsync(context, db);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
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
