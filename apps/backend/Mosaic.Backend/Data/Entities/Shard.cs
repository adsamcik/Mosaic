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
    public required string StorageKey { get; set; }
    public long SizeBytes { get; set; }
    public ShardStatus Status { get; set; } = ShardStatus.PENDING;
    public DateTime StatusUpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? PendingExpiresAt { get; set; }

    // Navigation
    public User? Uploader { get; set; }
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
