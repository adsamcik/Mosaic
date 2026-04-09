using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Albums;

/// <summary>
/// Request to create a new album with initial epoch key
/// </summary>
public class CreateAlbumRequest
{
    /// <summary>
    /// Initial epoch key bundle for the owner
    /// </summary>
    public required InitialEpochKeyRequest InitialEpochKey { get; set; }

    /// <summary>
    /// Base64-encoded encrypted album name (encrypted with epoch read key).
    /// Optional - if not provided, album name will not be stored.
    /// </summary>
    [MaxLength(2048)]
    public string? EncryptedName { get; set; }

    /// <summary>
    /// Base64-encoded encrypted album description (encrypted with epoch read key).
    /// Optional - if not provided, album description will not be stored.
    /// </summary>
    [MaxLength(8192)]
    public string? EncryptedDescription { get; set; }

    /// <summary>
    /// Optional expiration date for the album. Must be in the future if provided.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>
    /// Number of days before expiration to warn members. Defaults to 7 if not provided.
    /// </summary>
    public int? ExpirationWarningDays { get; set; }
}

/// <summary>
/// Request to update album expiration settings
/// </summary>
public record UpdateExpirationRequest(DateTimeOffset? ExpiresAt, int? ExpirationWarningDays);

/// <summary>
/// Request to rename an album (update encrypted name)
/// </summary>
public record RenameAlbumRequest([MaxLength(2048)] string EncryptedName);

/// <summary>
/// Request to update album description
/// </summary>
public record UpdateDescriptionRequest([MaxLength(8192)] string? EncryptedDescription);

/// <summary>
/// Initial epoch key data for album creation
/// </summary>
public class InitialEpochKeyRequest
{
    /// <summary>
    /// Base64-encoded sealed box containing encrypted epoch key bundle
    /// </summary>
    [MaxLength(4096)]
    public required byte[] EncryptedKeyBundle { get; set; }

    /// <summary>
    /// Base64-encoded Ed25519 signature from owner
    /// </summary>
    [MaxLength(128)]
    public required byte[] OwnerSignature { get; set; }

    /// <summary>
    /// Base64-encoded Ed25519 public key of sharer (owner for initial key)
    /// </summary>
    [MaxLength(64)]
    public required byte[] SharerPubkey { get; set; }

    /// <summary>
    /// Base64-encoded Ed25519 epoch signing public key
    /// </summary>
    [MaxLength(64)]
    public required byte[] SignPubkey { get; set; }
}
