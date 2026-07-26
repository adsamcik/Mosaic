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

    [Fact]
    public async Task ManifestV2Schemas_MatchRoutedValidationContract()
    {
        var doc = await GetOpenApiAsync();
        var createSchema = doc["components"]?["schemas"]?["CreateManifestRequest"];
        Assert.NotNull(createSchema);

        var createRequired = createSchema!["required"]!.AsArray()
            .Select(node => node!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);
        Assert.DoesNotContain("shardIds", createRequired);
        Assert.Contains("tieredShards", createRequired);
        Assert.Contains("manifestSeq", createRequired);
        Assert.Contains("sequenceReservationId", createRequired);

        var tieredShards = GetSchemaProperty(doc, "CreateManifestRequest", "tieredShards");
        Assert.NotNull(tieredShards);
        Assert.Equal(1, tieredShards!["minItems"]?.GetValue<int>());
        Assert.NotEqual(true, tieredShards["nullable"]?.GetValue<bool>());

        var manifestSeq = GetSchemaProperty(doc, "CreateManifestRequest", "manifestSeq");
        Assert.NotNull(manifestSeq);
        Assert.Equal(1, manifestSeq!["minimum"]?.GetValue<long>());
        Assert.NotEqual(true, manifestSeq["nullable"]?.GetValue<bool>());

        var expiresAt = GetSchemaProperty(doc, "CreateManifestRequest", "expiresAt");
        Assert.NotNull(expiresAt);
        Assert.Contains("send null", expiresAt!["description"]?.GetValue<string>());

        var deleteRequestBody = doc["paths"]?["/api/v1/manifests/{manifestId}"]?["delete"]?["requestBody"];
        Assert.NotNull(deleteRequestBody);
        Assert.True(deleteRequestBody!["required"]?.GetValue<bool>());

        var deleteSchema = doc["components"]?["schemas"]?["DeleteManifestRequest"];
        Assert.NotNull(deleteSchema);
        foreach (var field in new[]
        {
            "tombstoneSignature",
            "signerEpochId",
            "tombstoneSeq",
            "sequenceReservationId",
            "tombstoneVersionCreated"
        })
        {
            Assert.NotEqual(true, deleteSchema!["properties"]?[field]?["nullable"]?.GetValue<bool>());
        }
    }

    [Fact]
    public async Task IntrinsicCreateAndFinalizeResponses_DocumentActualStatusAndBodySchemas()
    {
        var doc = await GetOpenApiAsync();

        var albumResponses = doc["paths"]?["/api/v1/albums"]?["post"]?["responses"];
        Assert.NotNull(albumResponses?["201"]);
        Assert.Equal(
            "#/components/schemas/AlbumCreateResponse",
            albumResponses!["201"]?["content"]?["application/json"]?["schema"]?["$ref"]?.GetValue<string>());
        Assert.Null(albumResponses["200"]);

        var shareResponses = doc["paths"]?["/api/v1/albums/{albumId}/share-links"]?["post"]?["responses"];
        Assert.NotNull(shareResponses?["201"]);
        Assert.Equal(
            "#/components/schemas/ShareLinkResponse",
            shareResponses!["201"]?["content"]?["application/json"]?["schema"]?["$ref"]?.GetValue<string>());
        Assert.Null(shareResponses["200"]);

        var finalizeResponses = doc["paths"]?["/api/v1/manifests/{manifestId}/finalize"]?["post"]?["responses"];
        Assert.NotNull(finalizeResponses?["201"]);
        Assert.Equal(
            "#/components/schemas/ManifestFinalizeResponse",
            finalizeResponses!["201"]?["content"]?["application/json"]?["schema"]?["$ref"]?.GetValue<string>());

        var deleteResponses = doc["paths"]?["/api/v1/manifests/{manifestId}"]?["delete"]?["responses"];
        Assert.NotNull(deleteResponses?["204"]);
        Assert.Null(deleteResponses!["200"]);
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
