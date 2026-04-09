using System.ComponentModel.DataAnnotations;

namespace Mosaic.Backend.Models.Manifests;

public record CreateManifestRequest(
    Guid AlbumId,
    [MaxLength(1048576)] byte[] EncryptedMeta,
    [MaxLength(256)] string Signature,
    [MaxLength(128)] string SignerPubkey,
    [MaxLength(1000)] List<string> ShardIds,
    int? Tier = null,
    [MaxLength(1000)] List<TieredShardInfo>? TieredShards = null
);

public record TieredShardInfo([MaxLength(64)] string ShardId, int Tier);
