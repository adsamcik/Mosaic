using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class User
{
    public Guid Id { get; set; }
    [MaxLength(255)]
    public required string AuthSub { get; set; }
    [MaxLength(128)]
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
    [MaxLength(128)]
    public string? AuthPubkey { get; set; }

    /// <summary>
    /// Argon2id memory cost in KiB pinned at registration for cross-device login parity.
    /// </summary>
    [Required]
    public int KdfMemoryKib { get; set; } = 65536;

    /// <summary>
    /// Argon2id time cost pinned at registration.
    /// </summary>
    [Required]
    public int KdfIterations { get; set; } = 3;

    /// <summary>
    /// Argon2id parallelism pinned at registration.
    /// </summary>
    [Required]
    public int KdfParallelism { get; set; } = 1;

    /// <summary>
    /// Argon2 algorithm version pinned at registration. 0x13 is Argon2id v1.3.
    /// </summary>
    [Required]
    public byte KdfAlgVersion { get; set; } = 0x13;

    /// <summary>
    /// Monotonically-increasing version stamp of the password-derived key
    /// material on this account (<see cref="UserSalt"/>, <see cref="AuthPubkey"/>,
    /// <see cref="WrappedAccountKey"/>). Bumped by <c>POST /api/v1/auth/password-rotation</c>
    /// (v1.0.x s38). Defaults to 1 for legacy accounts so a never-rotated user
    /// is distinguishable from "rotated zero times". Clients use this to
    /// detect when their cached unwrapped keys are stale.
    /// </summary>
    [Required]
    public int SaltVersion { get; set; } = 1;

    /// <summary>
    /// Concurrency token for optimistic locking. Automatically incremented on update.
    /// </summary>
    public uint RowVersion { get; set; }

    // Navigation
    public ICollection<Album> OwnedAlbums { get; set; } = [];
    public ICollection<AlbumMember> Memberships { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public ICollection<Session> Sessions { get; set; } = [];
    public UserQuota? Quota { get; set; }
}
