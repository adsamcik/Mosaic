using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class TusUploadReservation
{
    [MaxLength(128)]
    public required string FileId { get; set; }
    public Guid UserId { get; set; }
    public Guid? AlbumId { get; set; }
    public long ReservedBytes { get; set; }
    public long UploadLength { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }

    public User User { get; set; } = null!;
    public Album? Album { get; set; }
}
