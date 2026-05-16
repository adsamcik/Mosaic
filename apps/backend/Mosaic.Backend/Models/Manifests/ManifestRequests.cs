using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace Mosaic.Backend.Models.Manifests;

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
    [MaxLength(1048576)] byte[]? EncryptedMetaSidecar,
    [MaxLength(256)] string Signature,
    [MaxLength(128)] string SignerPubkey,
    [MaxLength(1000)] List<string> ShardIds,
    /// <summary>
    /// Optional tier for all shards. Defaults to 3 (Original) if not provided.
    /// Use TieredShards for per-shard tier assignment.
    /// </summary>
    int? Tier = null,
    /// <summary>
    /// Optional list of shards with per-shard tier assignment.
    /// If provided, takes precedence over ShardIds.
    /// </summary>
    [MaxLength(1000)] List<TieredShardInfo>? TieredShards = null,
    /// <summary>
    /// Optional UTC expiration deadline for this photo. Null means no expiration.
    /// </summary>
    DateTimeOffset? ExpiresAt = null
) {
    [JsonConstructor]
    public CreateManifestRequest(
        Guid AlbumId,
        byte[] EncryptedMeta,
        string Signature,
        string SignerPubkey,
        List<string> ShardIds,
        int? Tier = null,
        List<TieredShardInfo>? TieredShards = null,
        DateTimeOffset? ExpiresAt = null)
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
            ExpiresAt)
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
    int EnvelopeVersion = 3);

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
    [MaxLength(128)] string SignerPubkey
);

/// <summary>
/// Optional request body for the soft-delete (tombstone) endpoint
/// (batch 5b — A2). When present, the client supplies an Ed25519 signature
/// over the canonical tombstone transcript
/// (<c>Mosaic_Tombstone_v1 || version || album || epoch || photo ||
/// version_created</c>) computed with the per-epoch signing key. The sync
/// client verifies the signature against the album's published signing
/// pubkey for <paramref name="SignerEpochId"/> before purging local state.
///
/// All fields are nullable so pre-A2 clients (no body, or body without
/// signature) keep working — the server stores NULL and v1 sync responses
/// are unchanged. Closes audit <c>sync C2 (unauthenticated tombstones)</c>.
/// </summary>
public record DeleteManifestRequest(
    [MaxLength(128)] string? TombstoneSignature,
    int? SignerEpochId
);
