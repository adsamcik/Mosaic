namespace Mosaic.Backend.Data.Entities;

public class Album
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public int CurrentEpochId { get; set; } = 1;
    public long CurrentVersion { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public User Owner { get; set; } = null!;
    public ICollection<AlbumMember> Members { get; set; } = [];
    public ICollection<Manifest> Manifests { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
}
