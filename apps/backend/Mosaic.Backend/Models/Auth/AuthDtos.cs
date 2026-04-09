using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Auth;

public record AuthInitRequest([MaxLength(256)] string Username);

public record AuthInitResponse
{
    public Guid ChallengeId { get; init; }
    public required string Challenge { get; init; }
    public required string UserSalt { get; init; }
    public long Timestamp { get; init; }
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
}

public record AuthRegisterRequest(
    [MaxLength(256)] string Username,
    [MaxLength(128)] string AuthPubkey,
    [MaxLength(128)] string IdentityPubkey,
    [MaxLength(128)] string UserSalt,
    [MaxLength(128)] string AccountSalt,
    [MaxLength(2048)] string? WrappedAccountKey = null,
    [MaxLength(2048)] string? WrappedIdentitySeed = null
);
