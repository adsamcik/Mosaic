using System.Net.Http;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Mosaic.Backend.Tests.OpenApi;

/// <summary>
/// Verifies the <see cref="Mosaic.Backend.OpenApi.DataAnnotationsSchemaTransformer"/>
/// pipes <c>[MinLength]</c>/<c>[MaxLength]</c>/<c>[StringLength]</c>/
/// <c>[Base64String]</c> onto the generated OpenAPI schema. Regression for
/// v1.0.2 openapi-newaccountsalt-shape.
/// </summary>
public class DataAnnotationsSchemaTransformerTests
    : IClassFixture<DataAnnotationsSchemaTransformerTests.OpenApiFactory>
{
    private readonly OpenApiFactory _factory;

    public DataAnnotationsSchemaTransformerTests(OpenApiFactory factory)
    {
        _factory = factory;
    }

    private async Task<JsonNode> GetOpenApiAsync()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/openapi/v1.json");
        response.EnsureSuccessStatusCode();
        var stream = await response.Content.ReadAsStreamAsync();
        var node = await JsonNode.ParseAsync(stream);
        Assert.NotNull(node);
        return node!;
    }

    private static JsonNode? GetSchemaProperty(JsonNode openapi, string schemaName, string propertyName)
    {
        return openapi["components"]?["schemas"]?[schemaName]?["properties"]?[propertyName];
    }

    [Fact]
    public async Task PasswordRotationRequest_NewAccountSalt_HasMinLengthAndMaxLengthAndFormatByte()
    {
        var doc = await GetOpenApiAsync();

        var newAccountSalt = GetSchemaProperty(doc, "PasswordRotationRequest", "newAccountSalt");
        Assert.NotNull(newAccountSalt);
        Assert.Equal(24, newAccountSalt!["minLength"]?.GetValue<int>());
        Assert.Equal(24, newAccountSalt["maxLength"]?.GetValue<int>());
        Assert.Equal("byte", newAccountSalt["format"]?.GetValue<string>());
    }

    [Fact]
    public async Task PasswordRotationRequest_NewUserSalt_HasMaxLength()
    {
        var doc = await GetOpenApiAsync();
        var prop = GetSchemaProperty(doc, "PasswordRotationRequest", "newUserSalt");
        Assert.NotNull(prop);
        Assert.Equal(128, prop!["maxLength"]?.GetValue<int>());
    }

    public sealed class OpenApiFactory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            // OpenAPI endpoint is only mapped in Development; this factory
            // forces Development env so the spec is queryable via HTTP.
            builder.UseEnvironment("Development");
            builder.UseSetting("ConnectionStrings:Default", "Data Source=:memory:");
        }
    }
}
