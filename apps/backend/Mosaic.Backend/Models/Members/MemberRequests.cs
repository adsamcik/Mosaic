using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Members;

/// <summary>
/// DTO for creating an epoch key during invite
/// </summary>
public record EpochKeyCreate(
    int EpochId,
    [MaxLength(8192)] string EncryptedKeyBundle,
    [MaxLength(256)] string OwnerSignature,
    [MaxLength(128)] string SharerPubkey,
    [MaxLength(128)] string SignPubkey
);

/// <summary>
/// Request to invite a member to an album with epoch keys
/// </summary>
public record InviteRequest(
    Guid RecipientId,
    [MaxLength(32)] string Role,
    [MaxLength(100)] EpochKeyCreate[] EpochKeys
);
