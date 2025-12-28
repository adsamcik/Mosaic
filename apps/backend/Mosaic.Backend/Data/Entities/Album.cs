namespace Mosaic.Backend.Data.Entities;

public class Album
{
    public Guid Id { get; set; }
    public Guid OwnerId { get; set; }
    public int CurrentEpochId { get; set; } = 1;
    public long CurrentVersion { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Base64-encoded encrypted album name (encrypted with epoch read key).
    /// Client-side encrypted, server stores opaque blob.
    /// </summary>
    public string? EncryptedName { get; set; }

    // Navigation
    public User Owner { get; set; } = null!;
    public ICollection<AlbumMember> Members { get; set; } = [];
    public ICollection<Manifest> Manifests { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
}
