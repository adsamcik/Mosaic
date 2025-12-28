namespace Mosaic.Backend.Data.Entities;

public class UserQuota
{
    public Guid UserId { get; set; }
    public long MaxStorageBytes { get; set; }
    public long UsedStorageBytes { get; set; }

    /// <summary>
    /// Maximum number of albums this user can own.
    /// Null means use system default.
    /// </summary>
    public int? MaxAlbums { get; set; }

    /// <summary>
    /// Current number of albums owned by this user.
    /// </summary>
    public int CurrentAlbumCount { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public User User { get; set; } = null!;
}
