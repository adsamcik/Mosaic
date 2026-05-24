using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Serilog.Context;

namespace Mosaic.Backend.Services;

/// <summary>
/// Stable event-type identifiers for the audit log (batch 7 — D1).
///
/// <para>
/// Centralised so emitters import a constant rather than a string literal —
/// a typo becomes a compile error instead of an event that silently never
/// shows up in incident-response queries.
/// </para>
///
/// <para>
/// Naming convention: dotted lower-kebab, increasing in specificity from
/// left to right (e.g. <c>album.member.removed</c>). Add new constants
/// alphabetically.
/// </para>
/// </summary>
public static class AuditEventTypes
{
    // Authentication
    public const string AuthLoginSucceeded = "auth.login";
    public const string AuthLoginFailed = "auth.login.failed";
    public const string AuthLogout = "auth.logout";

    // Album lifecycle
    public const string AlbumCreated = "album.created";
    public const string AlbumDeleted = "album.deleted";
    public const string AlbumMemberAdded = "album.member.added";
    public const string AlbumMemberRemoved = "album.member.removed";
    public const string AlbumEpochRotated = "album.epoch.rotated";

    // Share links
    public const string ShareLinkCreated = "share-link.created";
    public const string ShareLinkRevoked = "share-link.revoked";
    public const string ShareLinkAccessed = "share-link.accessed";

    // Admin
    public const string AdminQuotaChanged = "admin.quota.changed";
    public const string AdminUserPurged = "admin.user.purged";

    // User account lifecycle (v1.0.1 s15 — right-to-erasure)
    public const string UserSelfErased = "user.erased";

    // User data portability (v1.0.x s38 — GDPR Article 20)
    public const string UserDataExported = "user.data.exported";
}

/// <summary>
/// Stable outcome identifiers for <see cref="AuditLogEntry.Outcome"/>.
/// </summary>
public static class AuditOutcomes
{
    public const string Success = "success";
    public const string Denied = "denied";
    public const string Error = "error";
}

/// <summary>
/// Append-only audit log writer (batch 7 — D1, audit observability D-1).
///
/// <para>
/// Records who-did-what-when for security-relevant events. The service is
/// scoped (one per request) so it can write a row alongside the request
/// that triggered it. Callers should use the convenience
/// <see cref="WriteAsync(string, string, HttpContext?, Guid?, string?, string?, object?, CancellationToken)"/>
/// overload, which captures the current <see cref="Activity.TraceId"/>
/// and remote IP automatically.
/// </para>
///
/// <para>
/// Writes are best-effort: a database failure is logged but never thrown
/// back at the caller — losing one audit row should not break the user
/// flow that triggered the event. Persistent audit-write failures are
/// surfaced via the application logger so monitoring can alert on them.
/// </para>
/// </summary>
public interface IAuditLogService
{
    /// <summary>
    /// Persists a fully-built event. Prefer the convenience overload.
    /// </summary>
    Task WriteAsync(AuditLogEvent evt, CancellationToken ct = default);

    /// <summary>
    /// Persists an event, capturing <see cref="Activity.TraceId"/> and the
    /// remote address from <paramref name="context"/> automatically.
    /// </summary>
    /// <param name="eventType">One of <see cref="AuditEventTypes"/>.</param>
    /// <param name="outcome">One of <see cref="AuditOutcomes"/>.</param>
    /// <param name="context">Current HTTP context, when available.</param>
    /// <param name="actorUserId">Acting user id, when known.</param>
    /// <param name="targetType">Type of the targeted resource (<c>album</c>, <c>share-link</c>, ...).</param>
    /// <param name="targetId">Opaque id of the targeted resource.</param>
    /// <param name="details">Small NON-sensitive context object — serialised to JSON.</param>
    Task WriteAsync(
        string eventType,
        string outcome,
        HttpContext? context = null,
        Guid? actorUserId = null,
        string? targetType = null,
        string? targetId = null,
        object? details = null,
        CancellationToken ct = default);
}

/// <summary>
/// Immutable event payload passed to <see cref="IAuditLogService.WriteAsync(AuditLogEvent, CancellationToken)"/>.
/// </summary>
public sealed record AuditLogEvent
{
    public required string EventType { get; init; }
    public required string Outcome { get; init; }
    public Guid? ActorUserId { get; init; }
    public string? ActorRemoteAddress { get; init; }
    public string? TargetType { get; init; }
    public string? TargetId { get; init; }
    public string? RequestId { get; init; }
    public string? DetailsJson { get; init; }
}

/// <inheritdoc />
public sealed class AuditLogService : IAuditLogService
{
    /// <summary>
    /// Name of the Serilog <c>LogContext</c> property that tags an event as
    /// security-relevant. Used by the Serilog audit sink filter configured in
    /// <c>Program.cs</c> to route the message to the append-only audit log
    /// file. Tests reference this constant directly to avoid a stringly-typed
    /// coupling between the writer and the sink configuration.
    /// </summary>
    public const string CategoryPropertyName = "Category";

    /// <summary>
    /// Value of the <see cref="CategoryPropertyName"/> property that the
    /// audit sink filter matches.
    /// </summary>
    public const string AuditCategoryValue = "Audit";

    private static readonly JsonSerializerOptions DetailsJsonOptions = new()
    {
        WriteIndented = false,
    };

    private readonly MosaicDbContext _db;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<AuditLogService> _logger;

    public AuditLogService(
        MosaicDbContext db,
        TimeProvider timeProvider,
        ILogger<AuditLogService> logger)
    {
        _db = db;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task WriteAsync(AuditLogEvent evt, CancellationToken ct = default)
    {
        var entry = new AuditLogEntry
        {
            Id = Guid.CreateVersion7(),
            OccurredAt = _timeProvider.GetUtcNow(),
            EventType = evt.EventType,
            Outcome = evt.Outcome,
            ActorUserId = evt.ActorUserId,
            ActorRemoteAddress = Truncate(evt.ActorRemoteAddress, 64),
            TargetType = Truncate(evt.TargetType, 32),
            TargetId = Truncate(evt.TargetId, 128),
            RequestId = Truncate(evt.RequestId, 64),
            DetailsJson = Truncate(evt.DetailsJson, 4096),
        };

        try
        {
            _db.AuditLogEntries.Add(entry);
            await _db.SaveChangesAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Best-effort: do not bubble the failure to the caller.
            // Persistent failures should be surfaced via the application
            // logger so operators can alert on them.
            _logger.LogWarning(
                ex,
                "Failed to persist audit log entry {EventType} for actor {ActorUserId}",
                evt.EventType,
                evt.ActorUserId);
        }

        // v1.0.2 audit-event-sink: mirror the event to the Serilog audit sink
        // via a Category-tagged structured log. Pushing the property through
        // LogContext (rather than relying on a scope) lets the filter in
        // Program.cs route it to the append-only audit.log file. The DB write
        // remains the source of truth — the file sink is a redundant,
        // tamper-evident copy operators can ship to immutable storage. We
        // never include the DetailsJson body when it might contain free-form
        // data; only stable fields (event type, outcome, actor, target) flow
        // to the structured log so accidental PII leakage stays bounded.
        using (LogContext.PushProperty(CategoryPropertyName, AuditCategoryValue))
        using (LogContext.PushProperty("AuditEventType", entry.EventType))
        using (LogContext.PushProperty("AuditOutcome", entry.Outcome))
        using (LogContext.PushProperty("AuditActorUserId", entry.ActorUserId))
        using (LogContext.PushProperty("AuditTargetType", entry.TargetType))
        using (LogContext.PushProperty("AuditTargetId", entry.TargetId))
        using (LogContext.PushProperty("AuditRequestId", entry.RequestId))
        using (LogContext.PushProperty("AuditOccurredAt", entry.OccurredAt.ToString("o")))
        {
            _logger.LogInformation(
                "audit {AuditEventType} {AuditOutcome}",
                entry.EventType,
                entry.Outcome);
        }
    }

    /// <inheritdoc />
    public Task WriteAsync(
        string eventType,
        string outcome,
        HttpContext? context = null,
        Guid? actorUserId = null,
        string? targetType = null,
        string? targetId = null,
        object? details = null,
        CancellationToken ct = default)
    {
        var requestId = Activity.Current?.TraceId.ToString();
        var remote = context?.Connection?.RemoteIpAddress?.ToString();

        string? detailsJson = null;
        if (details is not null)
        {
            try
            {
                detailsJson = JsonSerializer.Serialize(details, DetailsJsonOptions);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Failed to serialize audit details for event {EventType}; event will still be logged without details",
                    eventType);
            }
        }

        return WriteAsync(
            new AuditLogEvent
            {
                EventType = eventType,
                Outcome = outcome,
                ActorUserId = actorUserId,
                ActorRemoteAddress = remote,
                TargetType = targetType,
                TargetId = targetId,
                RequestId = requestId,
                DetailsJson = detailsJson,
            },
            ct);
    }

    private static string? Truncate(string? value, int maxLength)
    {
        if (value is null)
        {
            return null;
        }
        return value.Length <= maxLength ? value : value[..maxLength];
    }
}
