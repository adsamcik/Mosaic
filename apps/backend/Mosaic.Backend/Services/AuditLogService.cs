using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

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
