namespace Mosaic.Backend.Models.TestSeed;

/// <summary>
/// Response for the expire-link endpoint.
/// </summary>
/// <param name="LinkId">The link ID that was expired.</param>
/// <param name="ExpiresAt">The new expiration time.</param>
public record ExpireLinkResponse(string LinkId, DateTimeOffset ExpiresAt);

/// <summary>
/// Response for the reset endpoint.
/// </summary>
/// <param name="DeletedUsers">Number of E2E test users that were deleted.</param>
public record ResetResponse(int DeletedUsers);

/// <summary>
/// Response for the ensure-pool endpoint.
/// </summary>
/// <param name="Users">All pool user emails.</param>
/// <param name="CreatedUsers">Emails of users that were created.</param>
/// <param name="ExistingUsers">Emails of users that already existed.</param>
public record EnsurePoolResponse(
    string[] Users,
    List<string> CreatedUsers,
    List<string> ExistingUsers
);

/// <summary>
/// Request for the create-user endpoint.
/// </summary>
/// <param name="Email">Email address for the user. Must end with @e2e.local.</param>
/// <param name="AuthMode">Authentication mode: "proxy" or "local".</param>
public record CreateUserRequest(string Email, string AuthMode);

/// <summary>
/// Response for the create-user endpoint.
/// </summary>
/// <param name="Id">The created user's ID.</param>
/// <param name="Email">The user's email/AuthSub.</param>
/// <param name="AuthMode">The authentication mode used.</param>
/// <param name="CreatedAt">When the user was created.</param>
public record CreateUserResponse(
    Guid Id,
    string Email,
    string AuthMode,
    DateTime CreatedAt
);

/// <summary>
/// Generic error response.
/// </summary>
/// <param name="Error">The error message.</param>
public record ErrorResponse(string Error);

/// <summary>
/// Request for the create-authenticated-user endpoint.
/// Creates a user with full crypto setup and returns a session cookie.
/// </summary>
/// <param name="Email">Email address for the user. Must end with @e2e.local.</param>
/// <param name="IdentityPubkey">Base64-encoded Ed25519 identity public key (optional).</param>
/// <param name="AuthPubkey">Base64-encoded Ed25519 auth public key for LocalAuth (optional).</param>
/// <param name="WrappedAccountKey">Encrypted account key wrapped by L1 key (optional).</param>
/// <param name="UserSalt">Base64url-encoded user salt for L0 derivation (optional, generated if not provided).</param>
/// <param name="AccountSalt">Base64url-encoded account salt for L1 derivation (optional, generated if not provided).</param>
public record CreateAuthenticatedUserRequest(
    string Email,
    string? IdentityPubkey = null,
    string? AuthPubkey = null,
    byte[]? WrappedAccountKey = null,
    string? UserSalt = null,
    string? AccountSalt = null
);

/// <summary>
/// Response for the create-authenticated-user endpoint.
/// </summary>
/// <param name="Id">The user's ID.</param>
/// <param name="Email">The user's email/AuthSub.</param>
/// <param name="WasCreated">True if user was created, false if it already existed.</param>
/// <param name="UserSalt">Base64url-encoded user salt (for localStorage).</param>
/// <param name="AccountSalt">Base64url-encoded account salt (for L1 derivation).</param>
/// <param name="SessionToken">Base64-encoded session token (also set in cookie).</param>
public record CreateAuthenticatedUserResponse(
    Guid Id,
    string Email,
    bool WasCreated,
    string UserSalt,
    string AccountSalt,
    string SessionToken
);
