using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Stores pending authentication challenges for the challenge-response protocol.
/// Challenges have a short TTL (60 seconds) and are single-use.
/// </summary>
public class AuthChallenge
{
    /// <summary>
    /// Primary key (UUIDv7 for time-ordered IDs).
    /// </summary>
    public Guid Id { get; set; }

    /// <summary>
    /// Username this challenge is for (may not exist in DB for anti-enumeration).
    /// </summary>
    [MaxLength(255)]
    public required string Username { get; set; }

    /// <summary>
    /// The random 32-byte challenge value.
    /// </summary>
    public required byte[] Challenge { get; set; }

    /// <summary>
    /// When the challenge was created.
    /// </summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// When the challenge expires (typically 60 seconds after creation).
    /// </summary>
    public DateTime ExpiresAt { get; set; }

    /// <summary>
    /// Whether the challenge has been used (prevents replay).
    /// </summary>
    public bool IsUsed { get; set; }

    /// <summary>
    /// IP address that requested the challenge (for rate limiting).
    /// </summary>
    [MaxLength(45)]
    public string? IpAddress { get; set; }
}
