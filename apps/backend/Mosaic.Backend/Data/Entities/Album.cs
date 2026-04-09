using System.ComponentModel.DataAnnotations;

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
    [MaxLength(500)]
    public string? EncryptedName { get; set; }

    /// <summary>
    /// Base64-encoded encrypted album description (encrypted with epoch read key).
    /// Client-side encrypted, server stores opaque blob.
    /// </summary>
    [MaxLength(4000)]
    public string? EncryptedDescription { get; set; }

    /// <summary>
    /// When the album will be automatically deleted. Null means no expiration.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>
    /// Number of days before expiration to warn members. Default is 7 days.
    /// </summary>
    public int ExpirationWarningDays { get; set; } = 7;

    /// <summary>
    /// Concurrency token for optimistic locking. Automatically incremented on update.
    /// </summary>
    public uint RowVersion { get; set; }

    // Navigation
    public User Owner { get; set; } = null!;
    public ICollection<AlbumMember> Members { get; set; } = [];
    public ICollection<Manifest> Manifests { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public AlbumLimits? Limits { get; set; }
}
