using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public enum ShardStatus
{
    PENDING,
    ACTIVE,
    TRASHED
}

public class Shard
{
    public Guid Id { get; set; }
    public Guid? UploaderId { get; set; }
    [MaxLength(255)]
    public required string StorageKey { get; set; }
    public long SizeBytes { get; set; }
    public ShardStatus Status { get; set; } = ShardStatus.PENDING;
    public DateTime StatusUpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? PendingExpiresAt { get; set; }

    /// <summary>
    /// SHA256 hash of the encrypted shard content (hex-encoded).
    /// Used for transport integrity verification during download.
    /// Computed server-side after upload completes.
    /// </summary>
    [MaxLength(64)]
    public string? Sha256 { get; set; }

    // Navigation
    public User? Uploader { get; set; }
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
