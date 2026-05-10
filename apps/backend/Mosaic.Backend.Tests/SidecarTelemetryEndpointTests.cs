using System.Reflection;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Mosaic.Backend.SidecarSignaling;
using Xunit;

namespace Mosaic.Backend.Tests;

/// <summary>
/// Integration tests for <c>POST /api/sidecar/telemetry/v1</c>.
/// Validates the strict JSON envelope shape: only enum-valued fields are
/// admitted; pseudonymous identifiers (room id, code, msg1, sessionId) and
/// continuous values (raw bytes, raw timestamps) cannot be smuggled in.
/// </summary>
public sealed class SidecarTelemetryEndpointTests
    : IClassFixture<SidecarSignalingTests.DefaultFactory>
{
    private readonly SidecarSignalingTests.DefaultFactory _factory;

    public SidecarTelemetryEndpointTests(SidecarSignalingTests.DefaultFactory factory)
    {
        _factory = factory;
    }

    private HttpClient NewClient() => _factory.CreateClient(new WebApplicationFactoryClientOptions
    {
        AllowAutoRedirect = false,
    });

    private static StringContent Json(string body) =>
        new(body, Encoding.UTF8, "application/json");

    private static Type TelemetryEnvelopeType => typeof(SidecarTelemetryEndpoint)
        .GetNestedType("TelemetryEnvelope", BindingFlags.NonPublic)!;

    private static JsonSerializerOptions TelemetryJsonOptions => (JsonSerializerOptions)typeof(SidecarTelemetryEndpoint)
        .GetField("JsonOpts", BindingFlags.NonPublic | BindingFlags.Static)!
        .GetValue(null)!;

    [Fact]
    public async Task ValidEnvelope_Returns204()
    {
        using var http = NewClient();
        var body = """
        { "events": [
            { "event": "pair-initiated" },
            { "event": "session-completed", "errCode": "WrongCode", "turnUsed": true,
              "photoCountBucket": "10-50", "bytesBucket": "medium",
              "throughputBucket": "fast", "durationBucket": "short" }
        ]}
        """;
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json(body));
        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    [Fact]
    public async Task EmptyEvents_Returns204()
    {
        using var http = NewClient();
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json("""{ "events": [] }"""));
        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    [Fact]
    public async Task MalformedJson_Returns400()
    {
        using var http = NewClient();
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json("{ not-json"));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task MissingEvents_Returns400()
    {
        using var http = NewClient();
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json("""{ "foo": 1 }"""));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Theory]
    [InlineData("not-an-event")]
    [InlineData("PAIR-INITIATED")] // case-sensitive
    [InlineData("")]
    public async Task InvalidEventName_Returns400(string evName)
    {
        using var http = NewClient();
        var body = $$"""{ "events": [ { "event": "{{evName}}" } ] }""";
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json(body));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Theory]
    [InlineData("errCode", "wrongcode")]
    [InlineData("photoCountBucket", "huge")]
    [InlineData("bytesBucket", "tiny")]
    [InlineData("throughputBucket", "snail")]
    [InlineData("durationBucket", "instant")]
    public async Task InvalidBucketValue_Returns400(string field, string value)
    {
        using var http = NewClient();
        var body = $$"""{ "events": [ { "event": "pair-completed", "{{field}}": "{{value}}" } ] }""";
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json(body));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public void JsonOptions_DeserializeKnownFields()
    {
        var body = """
        { "events": [
            { "event": "session-completed", "errCode": "WrongCode", "turnUsed": true,
              "photoCountBucket": "10-50", "bytesBucket": "medium",
              "throughputBucket": "fast", "durationBucket": "short" }
        ]}
        """;

        var envelope = JsonSerializer.Deserialize(body, TelemetryEnvelopeType, TelemetryJsonOptions);

        Assert.NotNull(envelope);
        var eventsProperty = TelemetryEnvelopeType.GetProperty("Events", BindingFlags.Public | BindingFlags.Instance)!;
        var events = Assert.IsAssignableFrom<System.Collections.IEnumerable>(eventsProperty.GetValue(envelope));
        Assert.Single(events.Cast<object>());
    }

    [Fact]
    public void JsonOptions_UnknownEventField_ThrowsJsonException()
    {
        var body = """
        { "events": [
            { "event": "pair-completed", "roomId": "deadbeefdeadbeefdeadbeefdeadbeef" }
        ]}
        """;

        var exception = Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize(body, TelemetryEnvelopeType, TelemetryJsonOptions));

        Assert.Contains("roomId", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UnknownProperties_Return400()
    {
        using var http = NewClient();
        var body = """
        { "events": [
            { "event": "pair-completed",
              "roomId": "deadbeefdeadbeefdeadbeefdeadbeef",
              "code": "123456",
              "sessionId": "leak",
              "bytes": 12345,
              "timestamp": 1700000000000 }
        ]}
        """;
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json(body));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task BatchTooLarge_Returns400()
    {
        using var http = NewClient();
        var sb = new StringBuilder();
        sb.Append("""{ "events": [""");
        for (var i = 0; i < 257; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("""{ "event": "pair-initiated" }""");
        }
        sb.Append("] }");
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json(sb.ToString()));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task BodyTooLarge_Returns413()
    {
        using var http = NewClient();
        // 17 KB padding inside a string field that the deserialiser will
        // ignore — we want the read-cap to engage before deserialisation.
        var huge = new string('x', 17 * 1024);
        var body = $$"""{ "events": [ { "event": "pair-initiated" } ], "padding": "{{huge}}" }""";
        var resp = await http.PostAsync("/api/sidecar/telemetry/v1", Json(body));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, resp.StatusCode);
    }
}
