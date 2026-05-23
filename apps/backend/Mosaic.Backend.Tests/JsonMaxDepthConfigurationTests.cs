using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Mosaic.Backend.Tests;

/// <summary>
/// Verifies the explicit System.Text.Json <c>MaxDepth=32</c> setting (v1.0.2 s36).
/// The .NET default is 64; we tighten it so a malicious client cannot drive deep
/// recursion via nested-object input.
/// </summary>
public sealed class JsonMaxDepthConfigurationTests
    : IClassFixture<SidecarSignalingTests.DefaultFactory>
{
    private readonly SidecarSignalingTests.DefaultFactory _factory;

    public JsonMaxDepthConfigurationTests(SidecarSignalingTests.DefaultFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public void MvcJsonOptions_HaveMaxDepth32()
    {
        using var scope = _factory.Services.CreateScope();
        var mvcOptions = scope.ServiceProvider
            .GetRequiredService<IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>>().Value;
        Assert.Equal(32, mvcOptions.JsonSerializerOptions.MaxDepth);
    }

    [Fact]
    public void HttpJsonOptions_HaveMaxDepth32()
    {
        using var scope = _factory.Services.CreateScope();
        var httpOptions = scope.ServiceProvider
            .GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value;
        Assert.Equal(32, httpOptions.SerializerOptions.MaxDepth);
    }
}
