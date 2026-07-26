using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Durable allocator state for one public manifest-signing key in an album.
/// The album row is locked while this value advances, making allocation
/// conflict-safe even when multiple clients reserve mutations concurrently.
/// </summary>
public sealed class ManifestSequenceState
{
    public Guid AlbumId { get; set; }

    /// <summary>Canonical base64 encoding of the 32-byte signing public key.</summary>
    [MaxLength(128)]
    public required string SignerPubkey { get; set; }

    /// <summary>The greatest sequence ever allocated for this signer stream.</summary>
    public long LastAllocatedSequence { get; set; }

    /// <summary>
    /// The greatest sequence whose signed mutation committed. A reservation
    /// at or below this watermark is stale and must be replaced and re-signed.
    /// </summary>
    public long LastConsumedSequence { get; set; }

    public Album Album { get; set; } = null!;
}
