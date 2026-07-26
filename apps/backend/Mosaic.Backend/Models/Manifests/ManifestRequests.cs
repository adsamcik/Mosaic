using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace Mosaic.Backend.Models.Manifests;

/// <summary>
/// Wire-protocol size limits enforced by the manifest model bindings.
/// These mirror the canonical caps in <c>SPEC-EncryptedMetaSidecar.md</c>
/// (and the Rust core's <c>MAX_SIDECAR_TOTAL_BYTES</c>) so the server
/// rejects malformed inputs at the model-binding layer with HTTP 400.
/// </summary>
public static class ManifestSizeLimits
{
    /// <summary>
    /// Maximum encoded plaintext sidecar bytes (TLV body inside the AEAD
    /// envelope). Locked to <c>65_536</c> by ADR-017 / SPEC-EncryptedMetaSidecar.
    /// </summary>
    public const int SidecarPlaintextMaxBytes = 65_536;

    /// <summary>
    /// SGzk v3 envelope header bytes: magic(4) | version(1) | epoch(4) |
    /// shard(4) | nonce(24) | tier(1) | reserved(26) = 64 bytes.
    /// </summary>
    public const int EnvelopeHeaderBytes = 64;

    /// <summary>
    /// Poly1305 authentication tag bytes appended by XChaCha20-Poly1305.
    /// </summary>
    public const int Poly1305TagBytes = 16;

    /// <summary>
    /// Maximum sealed sidecar byte length transmitted over the wire and
    /// persisted in <c>Manifest.EncryptedMetaSidecar</c>.
    /// </summary>
    public const int EncryptedMetaSidecarMaxBytes =
        SidecarPlaintextMaxBytes + EnvelopeHeaderBytes + Poly1305TagBytes;
}

/// <summary>
/// Manifest shard envelope versions accepted during the v0x03/v0x04
/// compatibility window. The backend stores ciphertext opaquely and persists
/// this client-reported decoder selector with each manifest-shard link.
/// </summary>
public static class ManifestEnvelopeVersions
{
    public const int SingleShot = 3;
    public const int Streaming = 4;

    public static bool IsSupported(int version) => version is SingleShot or Streaming;
}
/// <summary>Mutation kinds that share one v2 signer sequence stream.</summary>
public static class ManifestSequenceOperations
{
    public const string Create = "Create";
    public const string MetadataUpdate = "MetadataUpdate";
    public const string Tombstone = "Tombstone";

    public static bool IsSupported(string operationKind)
        => operationKind is Create or MetadataUpdate or Tombstone;
}

public sealed record ReserveManifestSequenceRequest(
    Guid AlbumId,
    [property: MaxLength(128)] string SignerPubkey,
    Guid TargetManifestId,
    Guid OperationId,
    [property: MaxLength(32)] string OperationKind);

public sealed record ManifestSequenceReservationResponse(
    Guid ReservationId,
    long ManifestSeq);


public record CreateManifestRequest(
    /// <summary>
    /// Manifest wire-format version. ADR-022 freezes v1 at protocolVersion=1.
    /// </summary>
    int ProtocolVersion,
    Guid AlbumId,
    /// <summary>
    /// Client-asserted opaque asset type. Server validates enum membership only.
    /// </summary>
    [MaxLength(16)] string AssetType,
    [MaxLength(1048576)] byte[] EncryptedMeta, // 1 MB max for encrypted metadata
    /// <summary>
    /// Encrypted metadata sidecar (SGzk envelope v3). Per
    /// <c>SPEC-EncryptedMetaSidecar.md</c> the inner plaintext TLV
    /// payload is capped at <c>MAX_SIDECAR_TOTAL_BYTES = 65_536</c>.
    /// The sealed envelope adds a 64-byte header (magic+version+epoch+
    /// shard+nonce+tier+reserved) and a 16-byte Poly1305 tag, so the
    /// server-side ceiling is <c>65_536 + 64 + 16 = 65_616 bytes</c>.
    /// Earlier code accepted 1 MiB, which allowed malicious clients to
    /// store oversized sidecars that honest clients would reject
    /// (security-review-2026-05-18-04).
    /// </summary>
    [property: MaxLength(ManifestSizeLimits.EncryptedMetaSidecarMaxBytes)] byte[]? EncryptedMetaSidecar,
    [MaxLength(256)] string Signature,
    [MaxLength(128)] string SignerPubkey,
    /// <summary>
    /// Legacy shard-id projection retained for source compatibility. Routed
    /// v2 finalization ignores this field; use TieredShards instead.
    /// </summary>
    [property: MaxLength(1000)] List<string>? ShardIds = null,
    /// <summary>
    /// Optional tier for all shards. Defaults to 3 (Original) if not provided.
    /// Use TieredShards for per-shard tier assignment.
    /// </summary>
    int? Tier = null,
    /// <summary>
    /// Optional list of shards with per-shard tier assignment.
    /// If provided, takes precedence over ShardIds.
    /// </summary>
    [property: Required, MinLength(1), MaxLength(1000)] List<TieredShardInfo>? TieredShards = null,
    /// <summary>
    /// Legacy compatibility field. Routed v2 finalization currently requires
    /// this value to be null because per-photo expiration has no signed
    /// reservation-backed lifecycle mutation yet.
    /// </summary>
    [property: Description("Reserved for a future signed lifecycle operation. Omit this field or send null; routed v2 finalization rejects a non-null value with HTTP 400.")]
    DateTimeOffset? ExpiresAt = null,
    /// <summary>
    /// Positive monotonic freshness sequence reserved for this exact v2
    /// manifest finalization. Required by every routed finalize request; the
    /// nullable CLR shape exists only for the non-routable legacy adapter.
    /// </summary>
    [property: Required, Range(1, long.MaxValue)] long? ManifestSeq = null,
    /// <summary>
    /// Reservation bound to the signer, album, target manifest, operation, and
    /// manifestSeq. Required by every routed finalize request.
    /// </summary>
    [property: Required] Guid? SequenceReservationId = null
) {
    [JsonConstructor]
    public CreateManifestRequest(
        Guid AlbumId,
        byte[] EncryptedMeta,
        string Signature,
        string SignerPubkey,
        List<string>? ShardIds = null,
        int? Tier = null,
        List<TieredShardInfo>? TieredShards = null,
        DateTimeOffset? ExpiresAt = null,
        long? ManifestSeq = null)
        : this(
            1,
            AlbumId,
            "Image",
            EncryptedMeta,
            null,
            Signature,
            SignerPubkey,
            ShardIds,
            Tier,
            TieredShards,
            ExpiresAt,
            ManifestSeq)
    {
    }
}

/// <summary>
/// Shard info with tier assignment
/// </summary>
public record TieredShardInfo(
    [MaxLength(64)] string ShardId,
    int Tier,
    int ShardIndex = 0,
    [MaxLength(64)] string? Sha256 = null,
    long? ContentLength = null,
    int EnvelopeVersion = ManifestEnvelopeVersions.SingleShot);

public sealed class ManifestFinalizeResponse
{
    public int ProtocolVersion { get; init; } = 1;
    public Guid ManifestId { get; init; }
    public long MetadataVersion { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public required IReadOnlyList<TieredShardInfo> TieredShards { get; init; }

    [System.Text.Json.Serialization.JsonIgnore]
    public Guid Id => ManifestId;
}

public record ManifestMetadataUpdateResponse(Guid Id, long VersionCreated);

public record ManifestExpirationUpdateResponse(Guid Id, DateTimeOffset? ExpiresAt, long VersionCreated);

public record UpdateManifestExpirationRequest(DateTimeOffset? ExpiresAt);

public record UpdateManifestMetadataRequest(
    [MaxLength(1048576)] string EncryptedMeta,
    [MaxLength(256)] string Signature,
    [MaxLength(128)] string SignerPubkey,
    [property: Required, Range(1, long.MaxValue)] long? ManifestSeq = null,
    [property: Required] Guid? SequenceReservationId = null
);

/// <summary>
/// Signed request body for the routed v2 soft-delete (tombstone) endpoint.
/// The client supplies an Ed25519 signature
/// over the canonical tombstone transcript
/// (<c>Mosaic_Tombstone_v1 || version || album || epoch || photo ||
/// version_created</c>) computed with the per-epoch signing key. The sync
/// client verifies the signature against the album's published signing
/// pubkey for <paramref name="SignerEpochId"/> before purging local state.
///
/// Every field is required on the routed v2 endpoint. Nullable CLR fields
/// remain only for the non-routable legacy in-process adapter.
/// </summary>
public record DeleteManifestRequest(
    [property: Required, MaxLength(128)] string? TombstoneSignature,
    [property: Required] int? SignerEpochId,
    [property: Required, Range(1, long.MaxValue)] long? TombstoneSeq = null,
    [property: Required] Guid? SequenceReservationId = null,
    [property: Required] long? TombstoneVersionCreated = null
);
