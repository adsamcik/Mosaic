namespace Mosaic.Backend.Models.Admin;

public record AlbumWithLimitsResponse(
    Guid Id,
    Guid OwnerId,
    string OwnerAuthSub,
    DateTime CreatedAt,
    AlbumLimitsResponse Limits
);

public record AlbumLimitsResponse(
    int MaxPhotos,
    int CurrentPhotoCount,
    long MaxSizeBytes,
    long CurrentSizeBytes,
    bool IsCustom
);

public record UpdateAlbumLimitsRequest(
    int? MaxPhotos,
    long? MaxSizeBytes
);
