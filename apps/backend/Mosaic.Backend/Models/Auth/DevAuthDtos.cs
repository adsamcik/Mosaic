#if DEBUG
using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Auth;

public record DevLoginRequest
{
    [Required]
    [MaxLength(256)]
    public required string Username { get; init; }
}

public record DevLoginResponse
{
    public required Guid UserId { get; init; }
    public required string Username { get; init; }
    public required string UserSalt { get; init; }
    public required string AccountSalt { get; init; }
    public required bool IsNewUser { get; init; }
}

public record DevUpdateKeysRequest
{
    [MaxLength(128)] public string? AuthPubkey { get; init; }
    [MaxLength(128)] public string? IdentityPubkey { get; init; }
    [MaxLength(2048)] public string? WrappedAccountKey { get; init; }
    [MaxLength(2048)] public string? WrappedIdentitySeed { get; init; }
}
#endif
