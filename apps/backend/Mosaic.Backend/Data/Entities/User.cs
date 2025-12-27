namespace Mosaic.Backend.Data.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string AuthSub { get; set; }
    public required string IdentityPubkey { get; set; }  // Base64 Ed25519
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

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

    // Navigation
    public ICollection<Album> OwnedAlbums { get; set; } = [];
    public ICollection<AlbumMember> Memberships { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public UserQuota? Quota { get; set; }
}
