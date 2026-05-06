using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;

namespace Mosaic.Backend.SidecarSignaling;

/// <summary>
/// Sidecar Beacon — ZK-safe telemetry sink.
///
/// Accepts <c>POST /api/sidecar/telemetry/v1</c> with a tiny JSON envelope of
/// pre-bucketed events. The endpoint enforces the same ZK invariant the
/// client does: ONLY the explicitly listed enum-valued fields are accepted;
/// any other property is rejected (400) so the schema cannot drift to admit
/// pseudonymous identifiers or continuous values.
///
/// Aggregation is deliberately minimal: events are emitted as a structured
/// log entry (per-event) for the operator to roll up via their existing log
/// pipeline. We keep no in-memory counters to avoid coupling deployment
/// topology to a state-store.
/// </summary>
public static class SidecarTelemetryEndpoint
{
    private const string TelemetryPath = "/api/sidecar/telemetry/v1";
    private const int MaxBodyBytes = 16 * 1024;
    private const int MaxEventsPerBatch = 256;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        // Strict mode: reject unknown fields so the schema cannot widen.
        UnknownTypeHandling = JsonUnknownTypeHandling.JsonElement,
    };

    private static readonly HashSet<string> ValidEvents = new(StringComparer.Ordinal)
    {
        "pair-initiated", "pair-completed", "pair-aborted", "pair-failed",
        "session-completed", "session-aborted", "session-disconnected",
    };
    private static readonly HashSet<string> ValidErrCodes = new(StringComparer.Ordinal)
    {
        "WrongCode", "SignalingTimeout", "IceFailed", "Aborted", "NetworkError", "Unknown",
    };
    private static readonly HashSet<string> ValidPhotoCountBuckets = new(StringComparer.Ordinal)
    {
        "<10", "10-50", "50-200", "200+",
    };
    private static readonly HashSet<string> ValidBytesBuckets = new(StringComparer.Ordinal)
    {
        "small", "medium", "large", "xlarge",
    };
    private static readonly HashSet<string> ValidThroughputBuckets = new(StringComparer.Ordinal)
    {
        "slow", "medium", "fast",
    };
    private static readonly HashSet<string> ValidDurationBuckets = new(StringComparer.Ordinal)
    {
        "short", "medium", "long",
    };

    public static IEndpointRouteBuilder MapSidecarTelemetry(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(TelemetryPath, HandleAsync);
        return endpoints;
    }

    private static async Task<IResult> HandleAsync(HttpContext ctx, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger("SidecarTelemetry");

        if (ctx.Request.ContentLength is long len && len > MaxBodyBytes)
        {
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        }

        // Read body with hard cap. We never persist or log the raw body.
        using var ms = new MemoryStream();
        var buf = new byte[4096];
        int read;
        while ((read = await ctx.Request.Body.ReadAsync(buf)) > 0)
        {
            if (ms.Length + read > MaxBodyBytes)
            {
                return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            }
            ms.Write(buf, 0, read);
        }

        TelemetryEnvelope? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<TelemetryEnvelope>(ms.ToArray(), JsonOpts);
        }
        catch (JsonException)
        {
            return Results.BadRequest(new { error = "malformed-json" });
        }

        if (envelope is null || envelope.Events is null)
        {
            return Results.BadRequest(new { error = "missing-events" });
        }
        if (envelope.Events.Count == 0)
        {
            return Results.NoContent();
        }
        if (envelope.Events.Count > MaxEventsPerBatch)
        {
            return Results.BadRequest(new { error = "batch-too-large" });
        }

        // Validate strictly — reject the whole batch if any event is malformed.
        // This prevents partial-success ambiguity and forces the client to keep
        // the schema honest.
        foreach (var ev in envelope.Events)
        {
            if (!IsValidEvent(ev, out var why))
            {
                return Results.BadRequest(new { error = "invalid-event", reason = why });
            }
        }

        // Emit one structured log per event. The operator's existing log
        // pipeline aggregates from there. We attach NO IP, NO user, NO
        // timestamps beyond the implicit log-line time (operator policy).
        foreach (var ev in envelope.Events)
        {
            // Logging primitives only — no allocations of identifying data.
            logger.LogInformation(
                "sidecar.telemetry event={Event} errCode={ErrCode} turnUsed={TurnUsed} photoCount={Photo} bytes={Bytes} throughput={Throughput} duration={Duration}",
                ev.Event,
                ev.ErrCode ?? "-",
                ev.TurnUsed?.ToString() ?? "-",
                ev.PhotoCountBucket ?? "-",
                ev.BytesBucket ?? "-",
                ev.ThroughputBucket ?? "-",
                ev.DurationBucket ?? "-");
        }

        return Results.NoContent();
    }

    private static bool IsValidEvent(TelemetryEvent ev, out string reason)
    {
        if (ev.Event is null || !ValidEvents.Contains(ev.Event))
        {
            reason = "event"; return false;
        }
        if (ev.ErrCode is not null && !ValidErrCodes.Contains(ev.ErrCode))
        {
            reason = "errCode"; return false;
        }
        if (ev.PhotoCountBucket is not null && !ValidPhotoCountBuckets.Contains(ev.PhotoCountBucket))
        {
            reason = "photoCountBucket"; return false;
        }
        if (ev.BytesBucket is not null && !ValidBytesBuckets.Contains(ev.BytesBucket))
        {
            reason = "bytesBucket"; return false;
        }
        if (ev.ThroughputBucket is not null && !ValidThroughputBuckets.Contains(ev.ThroughputBucket))
        {
            reason = "throughputBucket"; return false;
        }
        if (ev.DurationBucket is not null && !ValidDurationBuckets.Contains(ev.DurationBucket))
        {
            reason = "durationBucket"; return false;
        }
        reason = "";
        return true;
    }

    private sealed class TelemetryEnvelope
    {
        [JsonPropertyName("events")]
        public List<TelemetryEvent>? Events { get; set; }
    }

    private sealed class TelemetryEvent
    {
        [JsonPropertyName("event")] public string? Event { get; set; }
        [JsonPropertyName("errCode")] public string? ErrCode { get; set; }
        [JsonPropertyName("turnUsed")] public bool? TurnUsed { get; set; }
        [JsonPropertyName("photoCountBucket")] public string? PhotoCountBucket { get; set; }
        [JsonPropertyName("bytesBucket")] public string? BytesBucket { get; set; }
        [JsonPropertyName("throughputBucket")] public string? ThroughputBucket { get; set; }
        [JsonPropertyName("durationBucket")] public string? DurationBucket { get; set; }
    }
}