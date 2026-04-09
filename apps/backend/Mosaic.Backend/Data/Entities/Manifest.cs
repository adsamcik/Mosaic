using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class Manifest
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    [MaxLength(128)]
    public required string Signature { get; set; }
    [MaxLength(128)]
    public required string SignerPubkey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Concurrency token for optimistic locking. Automatically incremented on update.
    /// </summary>
    public uint RowVersion { get; set; }

    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
