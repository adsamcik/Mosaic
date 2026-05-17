using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Append-only audit log row for security-relevant server events
/// (batch 7 — D1, audit observability D-1).
///
/// <para>
/// Persists who-did-what-when for events that matter for incident
/// response: authentication (login / logout / failed sign-in), album
/// sharing (create / revoke / member add / member remove), epoch
/// rotations, and admin actions. The log is <b>append-only</b> — no
/// service is allowed to UPDATE or DELETE rows. Operators can re-derive
/// timelines from the log even after a compromised admin attempts to
/// cover tracks.
/// </para>
///
/// <para>
/// Zero-knowledge invariant: this table NEVER contains plaintext key
/// material, photo bytes, or encrypted metadata. <see cref="DetailsJson"/>
/// is intentionally a small JSON blob of operational context only
/// (e.g. <c>{ "albumId": "...", "newRosterVersion": 3 }</c>). Anything
/// the server cannot already see is forbidden from being logged here.
/// </para>
///
/// <para>
/// <see cref="ActorUserId"/> is nullable so we can record events that
/// happen <i>before</i> the user is identified (e.g. failed login
/// attempts against a non-existent username).
/// </para>
/// </summary>
public class AuditLogEntry
{
    public Guid Id { get; set; }

    /// <summary>When the event happened (UTC). Indexed for time-range queries.</summary>
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// The acting user, when known. NULL for pre-auth events (e.g.
    /// failed sign-in) and for system-initiated events (e.g. scheduled
    /// expiration purge).
    /// </summary>
    public Guid? ActorUserId { get; set; }

    /// <summary>
    /// Source IP address of the request, truncated to a privacy-preserving
    /// prefix when storage is configured to do so. Optional. Useful for
    /// rate-limit forensics on unauthenticated events.
    /// </summary>
    [MaxLength(64)]
    public string? ActorRemoteAddress { get; set; }

    /// <summary>
    /// Short, stable event name in dotted lower-kebab (e.g.
    /// <c>auth.login</c>, <c>album.member.removed</c>,
    /// <c>share-link.revoked</c>). The set is fixed in code so a
    /// drifted producer surfaces as a compile error rather than a typo.
    /// </summary>
    [MaxLength(64)]
    public required string EventType { get; set; }

    /// <summary>
    /// Type of the target resource, when applicable
    /// (e.g. <c>album</c>, <c>share-link</c>, <c>user</c>).
    /// </summary>
    [MaxLength(32)]
    public string? TargetType { get; set; }

    /// <summary>
    /// Opaque identifier of the target resource. Usually a Guid stored
    /// as a 36-char string; for share links we record the linkId hash,
    /// never the raw secret.
    /// </summary>
    [MaxLength(128)]
    public string? TargetId { get; set; }

    /// <summary>
    /// Outcome of the action: <c>success</c>, <c>denied</c>, or
    /// <c>error</c>.
    /// </summary>
    [MaxLength(16)]
    public required string Outcome { get; set; }

    /// <summary>
    /// Correlation id for cross-referencing application logs. Set to
    /// the current Activity / TraceId when available.
    /// </summary>
    [MaxLength(64)]
    public string? RequestId { get; set; }

    /// <summary>
    /// Small JSON blob of additional, NON-SENSITIVE operational context
    /// (e.g. <c>{ "rosterVersion": 7 }</c>). Hard-capped to 4 KiB so a
    /// runaway emitter cannot bloat the table. Never contains key
    /// material, photo data, or encrypted metadata.
    /// </summary>
    [MaxLength(4096)]
    public string? DetailsJson { get; set; }

    /// <summary>
    /// GDPR Article 17 right-to-erasure marker (v1.0.1 s15).
    ///
    /// <para>
    /// Set to <c>true</c> when the actor referenced by
    /// <see cref="ActorUserId"/> has invoked the self-service "delete
    /// my account" flow. At that point we anonymise the row by setting
    /// <see cref="ActorUserId"/> to <c>NULL</c> and flipping this flag,
    /// which preserves the audit trail (legitimate-interest legal basis
    /// for security incident response) while removing the personal
    /// reference required by Article 17.
    /// </para>
    ///
    /// <para>
    /// Rows where this flag is <c>true</c> and <see cref="ActorUserId"/>
    /// is <c>NULL</c> describe events whose original actor was a real
    /// user account that has since been erased — distinct from system
    /// or pre-auth events, which also have a <c>NULL</c> actor but with
    /// this flag <c>false</c>.
    /// </para>
    /// </summary>
    public bool ActorWasErased { get; set; }
}
