namespace Mosaic.Backend.Models.Admin;

public record UserWithQuotaResponse(
    Guid Id,
    string AuthSub,
    bool IsAdmin,
    DateTime CreatedAt,
    UserQuotaResponse Quota
);

public record UserQuotaResponse(
    long MaxStorageBytes,
    long UsedStorageBytes,
    int MaxAlbums,
    int CurrentAlbumCount,
    bool IsCustom
);

public record UpdateUserQuotaRequest(
    long? MaxStorageBytes,
    int? MaxAlbums
);
