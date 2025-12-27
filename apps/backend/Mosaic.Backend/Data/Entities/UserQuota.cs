namespace Mosaic.Backend.Data.Entities;

public class UserQuota
{
    public Guid UserId { get; set; }
    public long MaxStorageBytes { get; set; }
    public long UsedStorageBytes { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public User User { get; set; } = null!;
}
