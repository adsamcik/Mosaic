using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.ShareLinks;

/// <summary>
/// Wrapped key for a specific epoch and tier
/// </summary>
public class WrappedKeyRequest
{
    public int EpochId { get; set; }

    [Range(1, 3, ErrorMessage = "Tier must be between 1 and 3")]
    public int Tier { get; set; }

    [Required]
    [MinLength(24, ErrorMessage = "Nonce must be exactly 24 bytes")]
    [MaxLength(24, ErrorMessage = "Nonce must be exactly 24 bytes")]
    public required byte[] Nonce { get; set; }

    [Required]
    [MinLength(1, ErrorMessage = "EncryptedKey must not be empty")]
    [MaxLength(4096)]
    public required byte[] EncryptedKey { get; set; }
}

/// <summary>
/// Request to create a share link
/// </summary>
public class CreateShareLinkRequest
{
    [Range(1, 3, ErrorMessage = "AccessTier must be 1, 2, or 3")]
    public int AccessTier { get; set; }

    public DateTimeOffset? ExpiresAt { get; set; }

    [Range(1, int.MaxValue, ErrorMessage = "MaxUses must be positive")]
    public int? MaxUses { get; set; }

    [MaxLength(4096)]
    public byte[]? OwnerEncryptedSecret { get; set; }

    [Required]
    [MinLength(16, ErrorMessage = "LinkId must be exactly 16 bytes")]
    [MaxLength(16, ErrorMessage = "LinkId must be exactly 16 bytes")]
    public required byte[] LinkId { get; set; }

    [Required]
    [MinLength(1, ErrorMessage = "At least one wrapped key is required")]
    [MaxLength(64, ErrorMessage = "Too many wrapped keys")]
    public required List<WrappedKeyRequest> WrappedKeys { get; set; }
}

/// <summary>
/// Request to add epoch keys to an existing share link
/// </summary>
public class AddEpochKeysRequest
{
    [Required]
    [MinLength(1, ErrorMessage = "At least one epoch key is required")]
    [MaxLength(64, ErrorMessage = "Too many epoch keys")]
    public required List<EpochKeyDto> EpochKeys { get; set; }
}

/// <summary>
/// Request to update share link expiration settings
/// </summary>
public record UpdateLinkExpirationRequest(
    DateTimeOffset? ExpiresAt,
    [Range(1, int.MaxValue, ErrorMessage = "MaxUses must be positive")] int? MaxUses
);

/// <summary>
/// Epoch key data for adding to a share link
/// </summary>
public class EpochKeyDto
{
    public int EpochId { get; set; }

    [Range(1, 3, ErrorMessage = "Tier must be between 1 and 3")]
    public int Tier { get; set; }

    [Required]
    [MinLength(24, ErrorMessage = "Nonce must be exactly 24 bytes")]
    [MaxLength(24, ErrorMessage = "Nonce must be exactly 24 bytes")]
    public required byte[] Nonce { get; set; }

    [Required]
    [MinLength(1, ErrorMessage = "EncryptedKey must not be empty")]
    [MaxLength(4096)]
    public required byte[] EncryptedKey { get; set; }
}
