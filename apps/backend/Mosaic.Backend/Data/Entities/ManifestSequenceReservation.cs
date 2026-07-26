using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// A server-issued, client-consumable sequence reservation. The client obtains
/// this before signing a v2 manifest, metadata update, or tombstone. A row is
/// consumed atomically with the mutation it authorizes and remains durable so
/// gaps caused by abandoned uploads can never be reused.
/// </summary>
public sealed class ManifestSequenceReservation
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }

    [MaxLength(128)]
    public required string SignerPubkey { get; set; }

    /// <summary>The manifest targeted by this mutation.</summary>
    public Guid TargetManifestId { get; set; }

    /// <summary>Stable client operation identifier used to make reservation retries idempotent.</summary>
    public Guid OperationId { get; set; }

    /// <summary>One of Create, MetadataUpdate, or Tombstone.</summary>
    [MaxLength(32)]
    public required string OperationKind { get; set; }

    /// <summary>Positive sequence allocated from the signer stream.</summary>
    public long ManifestSeq { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ConsumedAt { get; set; }

    public Album Album { get; set; } = null!;
}
