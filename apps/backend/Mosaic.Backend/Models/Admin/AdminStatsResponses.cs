namespace Mosaic.Backend.Models.Admin;

public record SystemStatsResponse(
    int TotalUsers,
    int TotalAlbums,
    int TotalPhotos,
    long TotalStorageBytes,
    List<UserQuotaWarning> UsersNearQuota,
    List<AlbumLimitWarning> AlbumsNearLimit
);

public record UserQuotaWarning(
    Guid UserId,
    string AuthSub,
    int UsagePercent
);

public record AlbumLimitWarning(
    Guid AlbumId,
    string OwnerAuthSub,
    int PhotoUsagePercent,
    int SizeUsagePercent
);
