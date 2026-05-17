using System.ComponentModel.DataAnnotations;

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
    [Range(1, long.MaxValue, ErrorMessage = "MaxStorageBytes must be positive")] long? MaxStorageBytes,
    [Range(1, int.MaxValue, ErrorMessage = "MaxAlbums must be positive")] int? MaxAlbums
);
