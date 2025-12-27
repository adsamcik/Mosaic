namespace Mosaic.Backend.Data.Entities;

public class Manifest
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public required string Signature { get; set; }
    public required string SignerPubkey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
