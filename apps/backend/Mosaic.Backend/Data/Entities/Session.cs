using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Represents an active user session for local authentication.
/// Session tokens are hashed before storage to prevent theft if DB is compromised.
/// </summary>
public class Session
{
    /// <summary>
    /// Primary key (UUIDv7 for time-ordered IDs).
    /// </summary>
    public Guid Id { get; set; }

    /// <summary>
    /// Foreign key to the user who owns this session.
    /// </summary>
    public Guid UserId { get; set; }

    /// <summary>
    /// SHA256 hash of the session token. 
    /// We store the hash, not the raw token, so DB compromise doesn't leak valid tokens.
    /// </summary>
    public required byte[] TokenHash { get; set; }

    /// <summary>
    /// When the session was created.
    /// </summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// When the session was last used (for sliding expiration).
    /// </summary>
    public DateTime LastSeenAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// When the session expires (absolute expiration).
    /// </summary>
    public DateTime ExpiresAt { get; set; }

    /// <summary>
    /// When the session was revoked (null if still active).
    /// </summary>
    public DateTime? RevokedAt { get; set; }

    /// <summary>
    /// User agent string for device identification.
    /// </summary>
    [MaxLength(500)]
    public string? UserAgent { get; set; }

    /// <summary>
    /// IP address of the client when session was created.
    /// </summary>
    [MaxLength(45)]
    public string? IpAddress { get; set; }

    /// <summary>
    /// Optional device name (e.g., "Chrome on Windows").
    /// </summary>
    [MaxLength(255)]
    public string? DeviceName { get; set; }

    // Navigation
    public User User { get; set; } = null!;
}
