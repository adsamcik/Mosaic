namespace Mosaic.Backend.Data.Entities;

public class ManifestShard
{
    public Guid ManifestId { get; set; }
    public Guid ShardId { get; set; }
    public int ChunkIndex { get; set; }
    public int ShardIndex { get; set; }

    /// <summary>
    /// Quality tier of this shard (1=Thumb, 2=Preview, 3=Original).
    /// Default is 3 (Original) for backward compatibility.
    /// </summary>
    public int Tier { get; set; } = (int)ShardTier.Original;
    public string Sha256 { get; set; } = string.Empty;
    public long ContentLength { get; set; }
    public int EnvelopeVersion { get; set; } = 3;

    // Navigation
    public Manifest Manifest { get; set; } = null!;
    public Shard Shard { get; set; } = null!;
}
