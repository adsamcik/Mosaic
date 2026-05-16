using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Data.Entities;

public class Manifest
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public int ProtocolVersion { get; set; } = 1;
    [MaxLength(16)]
    public string AssetType { get; set; } = "Image";
    public long VersionCreated { get; set; }
    public long MetadataVersion { get; set; } = 1;
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public byte[]? EncryptedMetaSidecar { get; set; }
    [MaxLength(128)]
    public required string Signature { get; set; }
    [MaxLength(128)]
    public required string SignerPubkey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Ed25519 signature over the canonical tombstone transcript
    /// (mosaic-domain: <c>Mosaic_Tombstone_v1 || version || album || epoch ||
    /// photo || version_created</c>). NULL when the manifest is live or when
    /// the row was soft-deleted by a pre-A2 client without signing. The
    /// client that initiated the delete must sign this transcript with the
    /// per-epoch <c>ManifestSigningSecretKey</c>; the sync client verifies
    /// the signature against the album's published epoch signing pubkey
    /// before purging local state (audit <c>sync C2</c>).
    /// </summary>
    public byte[]? TombstoneSignature { get; set; }

    /// <summary>
    /// Epoch ID under which <see cref="TombstoneSignature"/> was produced.
    /// The sync client uses this to look up the right signing pubkey to
    /// verify against. NULL when no tombstone signature is present.
    /// </summary>
    public int? TombstoneSignerEpochId { get; set; }

    /// <summary>
    /// Monotonic freshness sequence for the manifest signing transcript v2
    /// (batch 6 — A3, audit <c>crypto-correctness H-1</c>). When the
    /// client signed the manifest with the v2 transcript (which embeds
    /// this value), the server enforces strict monotonicity per
    /// <c>(album_id, current_epoch_id)</c> on finalize so a stale signed
    /// manifest cannot be replayed under a newer seq value. NULL when
    /// the row was finalized by a pre-A3 client using the v1 transcript.
    /// </summary>
    public long? ManifestSeq { get; set; }

    /// <summary>
    /// When the photo manifest will be automatically deleted. Null means no expiration.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>
    /// Concurrency token for optimistic locking. Automatically incremented on update.
    /// </summary>
    public uint RowVersion { get; set; }

    // Navigation
    public Album Album { get; set; } = null!;
    public ICollection<ManifestShard> ManifestShards { get; set; } = [];
}
