namespace Mosaic.Backend.Models.Albums;

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
