using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class ShareLink
{
    private DateTimeOffset? _expiresAt;
    private DateTimeOffset _createdAt;

    public ShareLink()
    {
        _createdAt = DateTimeOffset.UtcNow;
        CreatedAtUnixMilliseconds = _createdAt.ToUnixTimeMilliseconds();
    }

    public Guid Id { get; set; }
    public required byte[] LinkId { get; set; }  // 16 bytes, derived from link secret
    public Guid AlbumId { get; set; }
    public int AccessTier { get; set; }  // 1=thumb, 2=preview, 3=full
    public byte[]? OwnerEncryptedSecret { get; set; }  // For owner to recover link secret if needed
    public DateTimeOffset? ExpiresAt
    {
        get => _expiresAt;
        set
        {
            _expiresAt = value;
            ExpiresAtUnixMilliseconds = value?.ToUnixTimeMilliseconds();
        }
    }
    public long? ExpiresAtUnixMilliseconds { get; private set; }
    public int? MaxUses { get; set; }  // Nullable for unlimited
    public int UseCount { get; set; } = 0;
    public bool IsRevoked { get; set; } = false;
    public DateTimeOffset CreatedAt
    {
        get => _createdAt;
        set
        {
            _createdAt = value;
            CreatedAtUnixMilliseconds = value.ToUnixTimeMilliseconds();
        }
    }
    public long CreatedAtUnixMilliseconds { get; private set; }
    /// <summary>
    /// SHA-256 fingerprint of the create request, committed atomically with
    /// the link and wrapped epoch keys for intrinsic retry recovery.
    /// </summary>
    [MaxLength(32)]
    public byte[]? CreateRequestHash { get; set; }

    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<LinkEpochKey> LinkEpochKeys { get; set; } = [];
    public ICollection<ShareLinkGrant> Grants { get; set; } = [];
}
