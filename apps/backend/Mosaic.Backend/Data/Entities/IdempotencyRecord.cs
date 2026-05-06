using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class IdempotencyRecord
{
    public Guid UserId { get; set; }

    [MaxLength(255)]
    public required string IdempotencyKey { get; set; }

    public required byte[] RequestHash { get; set; }

    public int ResponseStatus { get; set; }

    public required byte[] ResponseBodyHash { get; set; }

    public required byte[] ResponseBody { get; set; }

    public required string ResponseHeadersSubset { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public User User { get; set; } = null!;
}
