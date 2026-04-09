namespace Mosaic.Backend.Models.Admin;

public record UpdateQuotaDefaultsRequest(
    long MaxStorageBytesPerUser,
    int MaxAlbumsPerUser,
    int MaxPhotosPerAlbum,
    long MaxBytesPerAlbum
);
