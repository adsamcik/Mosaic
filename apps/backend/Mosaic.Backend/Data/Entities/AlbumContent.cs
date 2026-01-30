namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Encrypted content for album storytelling (blocks, text, narrative).
/// Server stores opaque encrypted blob - all decryption happens client-side.
/// </summary>
public class AlbumContent
{
    /// <summary>
    /// Primary key (same as AlbumId - 1:1 relationship)
    /// </summary>
    public Guid AlbumId { get; set; }

    /// <summary>
    /// Base64-encoded encrypted content document.
    /// Contains JSON array of blocks (heading, text, photo-group, etc.) 
    /// encrypted with content key derived from epoch seed.
    /// </summary>
    public required byte[] EncryptedContent { get; set; }

    /// <summary>
    /// 24-byte nonce used for content encryption.
    /// </summary>
    public required byte[] Nonce { get; set; }

    /// <summary>
    /// The epoch ID used for content encryption.
    /// Used for AAD binding to prevent replay attacks.
    /// </summary>
    public int EpochId { get; set; }

    /// <summary>
    /// Monotonically increasing version for optimistic concurrency.
    /// Incremented on every successful update.
    /// </summary>
    public long Version { get; set; } = 1;

    /// <summary>
    /// When the content was first created.
    /// </summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// When the content was last updated.
    /// </summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public Album Album { get; set; } = null!;
}
