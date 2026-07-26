namespace Mosaic.Backend.Models.Albums;

public sealed record AlbumCreateResponse(
    Guid Id,
    Guid OwnerId,
    int CurrentEpochId,
    long CurrentVersion,
    DateTime CreatedAt,
    string? EncryptedName,
    string? EncryptedDescription,
    DateTimeOffset? ExpiresAt,
    int ExpirationWarningDays,
    byte[]? MemberRosterSignature,
    int? MemberRosterSignerEpochId,
    long? MemberRosterVersion);

public record AlbumExpirationUpdateResponse(
    Guid Id,
    DateTimeOffset? ExpiresAt,
    int ExpirationWarningDays,
    DateTime UpdatedAt);

public record PhotoExpirationUpdateResponse(
    Guid Id,
    DateTimeOffset? ExpiresAt,
    long VersionCreated,
    DateTime UpdatedAt);

public record AlbumRenameResponse(
    Guid Id,
    string EncryptedName,
    DateTime UpdatedAt);

public record AlbumDescriptionUpdateResponse(
    Guid Id,
    string? EncryptedDescription,
    DateTime UpdatedAt);
