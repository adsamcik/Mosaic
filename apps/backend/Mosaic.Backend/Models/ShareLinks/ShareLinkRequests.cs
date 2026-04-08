namespace Mosaic.Backend.Models.ShareLinks;

/// <summary>
/// Wrapped key for a specific epoch and tier
/// </summary>
public class WrappedKeyRequest
{
    public int EpochId { get; set; }
    public int Tier { get; set; }
    public required byte[] Nonce { get; set; }
    public required byte[] EncryptedKey { get; set; }
}

/// <summary>
/// Request to create a share link
/// </summary>
public class CreateShareLinkRequest
{
    public int AccessTier { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public byte[]? OwnerEncryptedSecret { get; set; }
    public required byte[] LinkId { get; set; }
    public required List<WrappedKeyRequest> WrappedKeys { get; set; }
}

/// <summary>
/// Request to add epoch keys to an existing share link
/// </summary>
public class AddEpochKeysRequest
{
    public required List<EpochKeyDto> EpochKeys { get; set; }
}

/// <summary>
/// Request to update share link expiration settings
/// </summary>
public record UpdateLinkExpirationRequest(DateTimeOffset? ExpiresAt, int? MaxUses);

/// <summary>
/// Epoch key data for adding to a share link
/// </summary>
public class EpochKeyDto
{
    public int EpochId { get; set; }
    public int Tier { get; set; }
    public required byte[] Nonce { get; set; }
    public required byte[] EncryptedKey { get; set; }
}
