using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Manifests;

public record CreateManifestRequest(
    Guid AlbumId,
    [MaxLength(1048576)] byte[] EncryptedMeta, // 1 MB max for encrypted metadata
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
);

/// <summary>
/// Shard info with tier assignment
/// </summary>
public record TieredShardInfo([MaxLength(64)] string ShardId, int Tier);

public record UpdateManifestExpirationRequest(DateTimeOffset? ExpiresAt);

public record UpdateManifestMetadataRequest(
    [MaxLength(1048576)] string EncryptedMeta,
    [MaxLength(256)] string Signature,
    [MaxLength(128)] string SignerPubkey
);
