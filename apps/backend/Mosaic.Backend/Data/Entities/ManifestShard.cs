namespace Mosaic.Backend.Data.Entities;

public class ManifestShard
{
    public Guid ManifestId { get; set; }
    public Guid ShardId { get; set; }
    public int ChunkIndex { get; set; }

    // Navigation
    public Manifest Manifest { get; set; } = null!;
    public Shard Shard { get; set; } = null!;
}
