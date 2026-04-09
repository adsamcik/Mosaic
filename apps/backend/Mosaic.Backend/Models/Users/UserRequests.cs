using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Users;

public record UpdateUserRequest(
    [MaxLength(128)] string? IdentityPubkey = null,
    [MaxLength(256)] string? EncryptedSalt = null,
    [MaxLength(256)] string? SaltNonce = null
);

public record UpdateWrappedKeyRequest([MaxLength(2048)] string WrappedAccountKey);
