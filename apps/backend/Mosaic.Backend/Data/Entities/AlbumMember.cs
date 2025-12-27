namespace Mosaic.Backend.Data.Entities;

public class AlbumMember
{
    public Guid AlbumId { get; set; }
    public Guid UserId { get; set; }
    public required string Role { get; set; }  // "owner", "editor", "viewer"
    public Guid? InvitedBy { get; set; }
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
    public DateTime? RevokedAt { get; set; }

    // Navigation
    public Album Album { get; set; } = null!;
    public User User { get; set; } = null!;
    public User? Inviter { get; set; }
}
