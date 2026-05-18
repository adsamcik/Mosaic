using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Auth;

public record AuthInitRequest([MaxLength(256)] string Username);

public record AuthInitResponse
{
    public Guid ChallengeId { get; init; }
    public required string Challenge { get; init; }
    public required string UserSalt { get; init; }
    public long Timestamp { get; init; }
    public int KdfMemoryKib { get; init; }
    public int KdfIterations { get; init; }
    public int KdfParallelism { get; init; }
    public byte KdfAlgVersion { get; init; }
}

public record AuthVerifyRequest(
    [MaxLength(256)] string Username,
    Guid ChallengeId,
    [MaxLength(256)] string Signature,
    long? Timestamp = null
);

public record AuthVerifyResponse
{
    public bool Success { get; init; }
    public Guid UserId { get; init; }
    public string? AccountSalt { get; init; }
    public string? WrappedAccountKey { get; init; }
    public string? WrappedIdentitySeed { get; init; }
    public string? IdentityPubkey { get; init; }
    public int KdfMemoryKib { get; init; }
    public int KdfIterations { get; init; }
    public int KdfParallelism { get; init; }
    public byte KdfAlgVersion { get; init; }
}

public record AuthRegisterRequest(
    [MaxLength(256)] string Username,
    [MaxLength(128)] string AuthPubkey,
    [MaxLength(128)] string IdentityPubkey,
    [MaxLength(128)] string UserSalt,
    [MaxLength(128)] string AccountSalt,
    [MaxLength(2048)] string? WrappedAccountKey = null,
    [MaxLength(2048)] string? WrappedIdentitySeed = null,
    [Range(8192, 1_048_576)] long KdfMemoryKib = 65536,
    [Range(1, 32)] int KdfIterations = 3,
    [Range(1, 16)] int KdfParallelism = 1,
    byte KdfAlgVersion = 0x13
);

/// <summary>
/// Body for <c>POST /api/v1/auth/password-rotation</c> (v1.0.x s38).
///
/// <para>
/// Lets a logged-in user atomically replace their password-derived key
/// material — auth pubkey, user salt, and wrapped L2 account key — after
/// re-proving possession of the <i>current</i> password via a fresh
/// challenge-response signature. Server-side this is a single transaction
/// that:
/// </para>
///
/// <list type="number">
///   <item><description>Verifies <see cref="CurrentSignature"/> over the issued <see cref="ChallengeId"/> using the user's <i>existing</i> AuthPubkey.</description></item>
///   <item><description>Replaces <c>UserSalt</c>, <c>AuthPubkey</c>, and <c>WrappedAccountKey</c> with the new values.</description></item>
///   <item><description>Bumps <c>SaltVersion</c>.</description></item>
///   <item><description>Revokes every other active session so a stolen-cookie attacker is kicked out the moment the password changes.</description></item>
/// </list>
/// </summary>
public record PasswordRotationRequest(
    [property: Required] Guid ChallengeId,
    [property: Required, MaxLength(256)] string CurrentSignature,
    long? Timestamp,
    [property: Required, MaxLength(128)] string NewUserSalt,
    [property: Required, MaxLength(128)] string NewAuthPubkey,
    [property: Required, MaxLength(2048)] string NewWrappedAccountKey
);

/// <summary>
/// Response for <c>POST /api/v1/auth/password-rotation</c>.
/// </summary>
public record PasswordRotationResponse(int SaltVersion, int RevokedSessionCount);
