namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Per-album limits and usage tracking.
/// If MaxPhotos/MaxSizeBytes are null, system defaults are used.
/// </summary>
public class AlbumLimits
{
    public Guid AlbumId { get; set; }

    /// <summary>
    /// Maximum number of photos in this album.
    /// Null means use system default.
    /// </summary>
    public int? MaxPhotos { get; set; }

    /// <summary>
    /// Maximum total size of this album in bytes.
    /// Null means use system default.
    /// </summary>
    public long? MaxSizeBytes { get; set; }

    /// <summary>
    /// Current number of non-deleted photos in the album.
    /// </summary>
    public int CurrentPhotoCount { get; set; }

    /// <summary>
    /// Current total size of all shards in the album.
    /// </summary>
    public long CurrentSizeBytes { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public Album Album { get; set; } = null!;
}
