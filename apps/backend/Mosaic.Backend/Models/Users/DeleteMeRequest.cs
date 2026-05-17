using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Users;

/// <summary>
/// Request body for <c>DELETE /api/v1/users/me</c> (v1.0.1 s15 — GDPR Article 17
/// right-to-erasure self-service flow).
///
/// <para>
/// The endpoint is destructive and irreversible, so we require two independent
/// guards that a stolen session cookie alone cannot satisfy:
/// </para>
///
/// <list type="number">
///   <item>
///     <description>
///       <see cref="ConfirmationText"/> must match the caller's username
///       exactly. This prevents a single mis-click from wiping an account
///       and forces the user to type their identity.
///     </description>
///   </item>
///   <item>
///     <description>
///       In LocalAuth mode the caller must supply a fresh challenge id +
///       Ed25519 signature pair (<see cref="ChallengeId"/>,
///       <see cref="ConfirmationSignature"/>) just like
///       <c>POST /api/v1/auth/verify</c> — proving possession of the
///       password-derived auth key, not just the session cookie. In
///       ProxyAuth mode the upstream identity provider already gates
///       every request, so the signature pair is optional.
///     </description>
///   </item>
/// </list>
/// </summary>
public record DeleteMeRequest(
    /// <summary>
    /// Plain-text confirmation phrase the user must type — required to equal
    /// the caller's username (their <c>AuthSub</c>) before the cascade runs.
    /// Capped at 256 to match the username column length plus headroom.
    /// </summary>
    [property: Required(AllowEmptyStrings = false)]
    [property: MaxLength(256)]
    string ConfirmationText,

    /// <summary>
    /// LocalAuth-only: id of a fresh <c>auth_challenges</c> row issued via
    /// <c>POST /api/v1/auth/init</c> in the same logical step as this
    /// request. The challenge is single-use and short-lived; we claim it
    /// inside <c>DELETE /me</c> identically to <c>/auth/verify</c>.
    /// </summary>
    Guid? ChallengeId = null,

    /// <summary>
    /// LocalAuth-only: base64-encoded Ed25519 signature over the challenge
    /// transcript (same transcript builder as login). 64 raw bytes after
    /// decoding; capped at 8192 chars to bound request size.
    /// </summary>
    [property: MaxLength(8192)]
    string? ConfirmationSignature = null,

    /// <summary>
    /// LocalAuth-only: client-issued timestamp (ms since Unix epoch) that
    /// was bound into the challenge transcript when the signature was
    /// produced. Mirrors the <c>/auth/verify</c> request shape.
    /// </summary>
    long? Timestamp = null
);
