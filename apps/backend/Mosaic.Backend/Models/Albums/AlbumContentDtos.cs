using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Albums;

/// <summary>
/// Response containing encrypted album content
/// </summary>
public class AlbumContentResponse
{
    public required byte[] EncryptedContent { get; set; }
    public required byte[] Nonce { get; set; }
    public int EpochId { get; set; }
    public long Version { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// Request to create or update album content
/// </summary>
public class UpdateAlbumContentRequest
{
    [Required]
    [MaxLength(10 * 1024 * 1024)]
    public required byte[] EncryptedContent { get; set; }

    [Required]
    public required byte[] Nonce { get; set; }

    public int EpochId { get; set; }
    public long ExpectedVersion { get; set; }
}
