using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Admin;

public record UpdateQuotaDefaultsRequest(
    [Range(1, long.MaxValue, ErrorMessage = "MaxStorageBytesPerUser must be positive")]
    long MaxStorageBytesPerUser,
    [Range(1, int.MaxValue, ErrorMessage = "MaxAlbumsPerUser must be positive")]
    int MaxAlbumsPerUser,
    [Range(1, int.MaxValue, ErrorMessage = "MaxPhotosPerAlbum must be positive")]
    int MaxPhotosPerAlbum,
    [Range(1, long.MaxValue, ErrorMessage = "MaxBytesPerAlbum must be positive")]
    long MaxBytesPerAlbum
);
