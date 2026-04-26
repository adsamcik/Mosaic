using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class ShareLinkGrant
{
    public Guid Id { get; set; }
    public Guid ShareLinkId { get; set; }
    [MaxLength(32)]
    public required byte[] TokenHash { get; set; }
    public int GrantedUseCount { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public ShareLink ShareLink { get; set; } = null!;
}
