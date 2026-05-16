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

/// <summary>
/// One entry in an owner-signed member roster (batch C2 — closes audit
/// <c>threat-model C-3</c>). The owner signs a canonical roster of
/// <c>(member_id, role_byte)</c> entries; visitors verify before
/// rendering role badges so a compromised server cannot fabricate
/// admin/editor labels.
/// </summary>
public record SignedRosterMember(
    Guid UserId,
    /// <summary>
    /// Canonical role byte (mosaic-domain: 1=owner, 2=editor, 3=viewer).
    /// </summary>
    byte RoleByte
);

/// <summary>
/// Owner publishes a signed member roster for an album. The
/// <see cref="Signature"/> is over the canonical roster transcript
/// produced by <c>mosaic_domain::canonical_member_roster_transcript_bytes</c>.
///
/// The server does NOT verify the signature itself — the visitor client
/// is the authority. The server enforces:
/// - Caller is the album owner.
/// - <see cref="RosterVersion"/> is strictly greater than the current
///   stored version (monotonic — prevents server-side rollback of role
///   changes).
/// - <see cref="Signature"/> is exactly 64 bytes Ed25519.
/// - <see cref="SignerEpochId"/> resolves to an existing album epoch.
/// </summary>
public record PublishSignedRosterRequest(
    long RosterVersion,
    int SignerEpochId,
    [MaxLength(128)] string Signature,
    [MaxLength(100)] SignedRosterMember[] Members
);
