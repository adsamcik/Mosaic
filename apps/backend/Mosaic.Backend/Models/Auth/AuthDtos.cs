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
