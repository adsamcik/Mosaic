using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public enum TusUploadLifecycleState
{
    CREATED,
    RECEIVED,
    COMMITTING,
    COMMITTED,
    QUARANTINED,
    CANCELLED
}

/// <summary>
/// Durable completion lifecycle for a Tus file. The immutable Tus file ID is
/// the recovery key across the database and external blob-store boundary.
/// </summary>
public class TusUploadLifecycle
{
    [MaxLength(128)]
    public required string FileId { get; set; }

    public Guid UserId { get; set; }
    public Guid? AlbumId { get; set; }
    public long ReservedBytes { get; set; }
    public long UploadLength { get; set; }

    [MaxLength(64)]
    public string? ExpectedContentSha256 { get; set; }

    public int? EnvelopeVersion { get; set; }
    public TusUploadLifecycleState State { get; set; } = TusUploadLifecycleState.CREATED;
    public int ReconciliationAttempts { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ReceivedAt { get; set; }
    public DateTime? CommittingAt { get; set; }
    public DateTime? CommittedAt { get; set; }
    public DateTime? QuarantinedAt { get; set; }

    [MaxLength(512)]
    public string? QuarantineReason { get; set; }

    public User User { get; set; } = null!;
    public Album? Album { get; set; }
}
