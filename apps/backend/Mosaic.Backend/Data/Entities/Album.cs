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

    /// <summary>
    /// Owner-signed Ed25519 signature over the canonical roster transcript
    /// (mosaic-domain: <c>Mosaic_MemberRoster_v1 || version || album_id ||
    /// epoch_id || roster_version || member_count || sort(member_id ||
    /// role_byte)</c>). NULL when the album has no roster signature yet
    /// (newly-created album or pre-C2 row). The visitor verifies this
    /// signature against the album's published epoch signing pubkey before
    /// trusting role badges in the UI — a compromised server can no longer
    /// fabricate admin / editor labels (audit
    /// <c>threat-model C-3</c>).
    /// </summary>
    public byte[]? MemberRosterSignature { get; set; }

    /// <summary>
    /// Epoch ID under which <see cref="MemberRosterSignature"/> was produced.
    /// The visitor uses this to look up the correct signing pubkey to verify
    /// against. NULL when no roster signature is present.
    /// </summary>
    public int? MemberRosterSignerEpochId { get; set; }

    /// <summary>
    /// Monotonically increasing per-album roster version. The signed
    /// transcript binds this value so an older signed roster cannot be
    /// replayed after a role change. NULL when no roster signature is
    /// present.
    /// </summary>
    public long? MemberRosterVersion { get; set; }

    // Navigation
    public User Owner { get; set; } = null!;
    public ICollection<AlbumMember> Members { get; set; } = [];
    public ICollection<Manifest> Manifests { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public AlbumLimits? Limits { get; set; }
}
