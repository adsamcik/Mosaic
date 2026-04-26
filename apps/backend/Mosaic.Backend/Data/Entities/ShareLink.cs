namespace Mosaic.Backend.Data.Entities;

public class ShareLink
{
    public Guid Id { get; set; }
    public required byte[] LinkId { get; set; }  // 16 bytes, derived from link secret
    public Guid AlbumId { get; set; }
    public int AccessTier { get; set; }  // 1=thumb, 2=preview, 3=full
    public byte[]? OwnerEncryptedSecret { get; set; }  // For owner to recover link secret if needed
    public DateTimeOffset? ExpiresAt { get; set; }  // Nullable for no expiry
    public int? MaxUses { get; set; }  // Nullable for unlimited
    public int UseCount { get; set; } = 0;
    public bool IsRevoked { get; set; } = false;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<LinkEpochKey> LinkEpochKeys { get; set; } = [];
    public ICollection<ShareLinkGrant> Grants { get; set; } = [];
}
