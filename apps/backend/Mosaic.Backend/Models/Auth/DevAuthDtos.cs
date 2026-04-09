#if DEBUG
namespace Mosaic.Backend.Models.Auth;

public record DevLoginRequest
{
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
    public string? AuthPubkey { get; init; }
    public string? IdentityPubkey { get; init; }
    public string? WrappedAccountKey { get; init; }
    public string? WrappedIdentitySeed { get; init; }
}
#endif
