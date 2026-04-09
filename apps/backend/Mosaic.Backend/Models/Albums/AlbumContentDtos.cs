using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Albums;

/// <summary>
/// Response containing encrypted album content
/// </summary>
public class AlbumContentResponse
{
    /// <summary>
    /// Encrypted content document (blocks, text, etc.)
    /// </summary>
    public required byte[] EncryptedContent { get; set; }

    /// <summary>
    /// 24-byte nonce used for encryption
    /// </summary>
    public required byte[] Nonce { get; set; }

    /// <summary>
    /// Epoch ID used for content encryption
    /// </summary>
    public int EpochId { get; set; }

    /// <summary>
    /// Content version (for optimistic concurrency)
    /// </summary>
    public long Version { get; set; }

    /// <summary>
    /// When the content was last updated
    /// </summary>
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// Request to create or update album content
/// </summary>
public class UpdateAlbumContentRequest
{
    /// <summary>
    /// Encrypted content document
    /// </summary>
    [Required]
    [MaxLength(10 * 1024 * 1024)] // 10MB max
    public required byte[] EncryptedContent { get; set; }

    /// <summary>
    /// 24-byte nonce used for encryption
    /// </summary>
    [Required]
    public required byte[] Nonce { get; set; }

    /// <summary>
    /// Epoch ID used for content encryption
    /// </summary>
    public int EpochId { get; set; }

    /// <summary>
    /// Expected current version (0 for new content).
    /// Used for optimistic concurrency control.
    /// </summary>
    public long ExpectedVersion { get; set; }
}
