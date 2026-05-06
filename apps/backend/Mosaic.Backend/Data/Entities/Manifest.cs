using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class Manifest
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public int ProtocolVersion { get; set; } = 1;
    [MaxLength(16)]
    public string AssetType { get; set; } = "Image";
    public long VersionCreated { get; set; }
    public long MetadataVersion { get; set; } = 1;
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public byte[]? EncryptedMetaSidecar { get; set; }
    [MaxLength(128)]
    public required string Signature { get; set; }
    [MaxLength(128)]
    public required string SignerPubkey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// When the photo manifest will be automatically deleted. Null means no expiration.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>
    /// Concurrency token for optimistic locking. Automatically incremented on update.
    /// </summary>
    public uint RowVersion { get; set; }

    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
