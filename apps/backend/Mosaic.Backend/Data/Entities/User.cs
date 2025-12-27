namespace Mosaic.Backend.Data.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string AuthSub { get; set; }
    public required string IdentityPubkey { get; set; }  // Base64 Ed25519
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public ICollection<Album> OwnedAlbums { get; set; } = [];
    public ICollection<AlbumMember> Memberships { get; set; } = [];
    public ICollection<EpochKey> EpochKeys { get; set; } = [];
    public UserQuota? Quota { get; set; }
}
