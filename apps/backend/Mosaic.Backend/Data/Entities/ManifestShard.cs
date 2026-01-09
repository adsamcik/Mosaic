namespace Mosaic.Backend.Data.Entities;

public class ManifestShard
{
    public Guid ManifestId { get; set; }
    public Guid ShardId { get; set; }
    public int ChunkIndex { get; set; }

    /// <summary>
    /// Quality tier of this shard (1=Thumb, 2=Preview, 3=Original).
    /// Default is 3 (Original) for backward compatibility.
    /// </summary>
    public int Tier { get; set; } = (int)ShardTier.Original;

    // Navigation
    public Manifest Manifest { get; set; } = null!;
    public Shard Shard { get; set; } = null!;
}
