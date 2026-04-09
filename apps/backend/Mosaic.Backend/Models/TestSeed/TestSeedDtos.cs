#if DEBUG
namespace Mosaic.Backend.Models.TestSeed;

public record ExpireLinkResponse(string LinkId, DateTimeOffset ExpiresAt);
public record ResetResponse(int DeletedUsers);

public record EnsurePoolResponse(
    string[] Users,
    List<string> CreatedUsers,
    List<string> ExistingUsers
);

public record CreateUserRequest(string Email, string AuthMode);

public record CreateUserResponse(
    Guid Id,
    string Email,
    string AuthMode,
    DateTime CreatedAt
);

public record ErrorResponse(string Error);

public record CreateAuthenticatedUserRequest(
    string Email,
    string? IdentityPubkey = null,
    string? AuthPubkey = null,
    byte[]? WrappedAccountKey = null,
    string? UserSalt = null,
    string? AccountSalt = null
);

public record CreateAuthenticatedUserResponse(
    Guid Id,
    string Email,
    bool WasCreated,
    string UserSalt,
    string AccountSalt,
    string SessionToken
);
#endif
