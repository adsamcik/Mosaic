using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Members;

public record EpochKeyCreate(
    int EpochId,
    [MaxLength(8192)] string EncryptedKeyBundle,
    [MaxLength(256)] string OwnerSignature,
    [MaxLength(128)] string SharerPubkey,
    [MaxLength(128)] string SignPubkey
);

public record InviteRequest(
    Guid RecipientId,
    [MaxLength(32)] string Role,
    [MaxLength(100)] EpochKeyCreate[] EpochKeys
);
