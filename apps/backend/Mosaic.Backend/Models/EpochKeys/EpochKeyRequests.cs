using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.EpochKeys;

public record CreateEpochKeyRequest(
    Guid RecipientId,
    int EpochId,
    [MaxLength(4096)] byte[] EncryptedKeyBundle,
    [MaxLength(128)] byte[] OwnerSignature,
    [MaxLength(64)] byte[] SharerPubkey,
    [MaxLength(64)] byte[] SignPubkey
);

/// <summary>
/// Wrapped key for a share link at a specific tier
/// </summary>
public record ShareLinkWrappedKeyRequest(
    int Tier,
    byte[] Nonce,
    byte[] EncryptedKey
);

/// <summary>
/// Updated wrapped keys for a single share link
/// </summary>
public record ShareLinkKeyUpdateRequest(
    Guid ShareLinkId,
    ShareLinkWrappedKeyRequest[] WrappedKeys
);

public record RotateEpochRequest(
    CreateEpochKeyRequest[] EpochKeys,
    ShareLinkKeyUpdateRequest[]? ShareLinkKeys = null
);
