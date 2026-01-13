namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Represents the quality tier of a shard.
/// Higher tiers contain higher quality/larger files.
/// </summary>
public enum ShardTier
{
    /// <summary>
    /// Thumbnail tier - smallest, for gallery grids
    /// </summary>
    Thumb = 1,

    /// <summary>
    /// Preview tier - medium quality for lightbox viewing
    /// </summary>
    Preview = 2,

    /// <summary>
    /// Original tier - full quality original file
    /// </summary>
    Original = 3
}
