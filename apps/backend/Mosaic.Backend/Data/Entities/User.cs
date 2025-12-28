namespace Mosaic.Backend.Data.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string AuthSub { get; set; }
    public required string IdentityPubkey { get; set; }  // Base64 Ed25519
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Whether this user has admin privileges.
    /// Admins can manage quotas and view all users/albums.
    /// </summary>
    public bool IsAdmin { get; set; }

    /// <summary>
    /// Client-side encrypted user salt for multi-device key derivation.
    /// Encrypted with a key derived from password+username (no salt needed).
    /// Server never sees the plaintext salt.
    /// </summary>
    public byte[]? EncryptedSalt { get; set; }

    /// <summary>
    /// Nonce used for AES-GCM encryption of the salt.
    /// 12 bytes for AES-GCM.
    /// </summary>
    public byte[]? SaltNonce { get; set; }

    // ===== Local Auth Fields =====

    /// <summary>
    /// User salt for Argon2 key derivation (16 bytes, plaintext).
    /// Only used in LocalAuth mode.
    /// </summary>
    public byte[]? UserSalt { get; set; }

    /// <summary>
    /// Account salt for HKDF derivation (16 bytes, plaintext).
    /// Only used in LocalAuth mode.
    /// </summary>
    public byte[]? AccountSalt { get; set; }

    /// <summary>
    /// Wrapped account key (encrypted L2 key, ~48 bytes).
    /// Client uses this to unwrap their encryption keys after authentication.
    /// </summary>
    public byte[]? WrappedAccountKey { get; set; }

    /// <summary>
    /// Wrapped identity seed (encrypted seed for Ed25519 keypair, ~48 bytes).
    /// Used for album sharing signatures.
    /// </summary>
    public byte[]? WrappedIdentitySeed { get; set; }

    /// <summary>
    /// Auth public key for challenge-response verification (32 bytes, Base64).
    /// Separate from IdentityPubkey for security isolation.
    /// Derived from: Argon2id(password, userSalt) → BLAKE2b("Mosaic_AuthKey_v1")
    /// </summary>
    public string? AuthPubkey { get; set; }

    // Navigation
    public ICollection<Album> OwnedAlbums { get; set; } = [];
    public ICollection<AlbumMember> Memberships { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public ICollection<Session> Sessions { get; set; } = [];
    public UserQuota? Quota { get; set; }
}
