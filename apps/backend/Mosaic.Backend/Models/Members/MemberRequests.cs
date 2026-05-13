using System.ComponentModel.DataAnnotations;
using Mosaic.Backend.Models.EpochKeys;

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

/// <summary>
/// Atomic remove-member-and-rotate request body. Carries everything the
/// rotation service needs alongside the membership revocation so both
/// commit (or roll back) in a single transaction.
/// See <c>MembersController.RemoveAndRotate</c> for the rationale.
/// </summary>
public record RemoveAndRotateRequest(
    int EpochId,
    [MaxLength(100)] CreateEpochKeyRequest[] EpochKeys,
    [MaxLength(100)] ShareLinkKeyUpdateRequest[]? ShareLinkKeys = null
);
