using Mosaic.Backend.Data.Entities;
using System.Text.Json.Serialization;

namespace Mosaic.Backend.Models.Photos;

public class PhotoResponse
{
    public Guid Id { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Guid? AlbumId { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public required string Signature { get; set; }
    public required string SignerPubkey { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public required List<Guid> ShardIds { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TieredShardsResponse? TieredShards { get; set; }
}

public sealed class TieredShardsResponse
{
    public required List<Guid> Thumb { get; set; }
    public required List<Guid> Preview { get; set; }
    public required List<Guid> Original { get; set; }
}

public static class PhotoResponseFactory
{
    public const string TieredShardsMediaType = "application/vnd.mosaic.tiered-shards+json";

    public static bool WantsTieredShards(HttpRequest request)
        => request.Headers.Accept.Any(value =>
            value?.Contains(TieredShardsMediaType, StringComparison.OrdinalIgnoreCase) == true);

    public static PhotoResponse FromManifest(Manifest manifest, bool includeTieredShards, bool includeAlbumId)
    {
        var orderedShards = manifest.ManifestShards.OrderBy(ms => ms.ChunkIndex).ToList();
        return new PhotoResponse
        {
            Id = manifest.Id,
            AlbumId = includeAlbumId ? manifest.AlbumId : null,
            VersionCreated = manifest.VersionCreated,
            IsDeleted = manifest.IsDeleted,
            EncryptedMeta = manifest.EncryptedMeta,
            Signature = manifest.Signature,
            SignerPubkey = manifest.SignerPubkey,
            ExpiresAt = manifest.ExpiresAt,
            ShardIds = orderedShards.Select(ms => ms.ShardId).ToList(),
            TieredShards = includeTieredShards ? FromManifestShards(orderedShards) : null
        };
    }

    public static TieredShardsResponse FromManifestShards(IEnumerable<ManifestShard> manifestShards)
    {
        var ordered = manifestShards.OrderBy(ms => ms.ChunkIndex).ToList();
        return new TieredShardsResponse
        {
            Thumb = ordered.Where(ms => ms.Tier == (int)ShardTier.Thumb).Select(ms => ms.ShardId).ToList(),
            Preview = ordered.Where(ms => ms.Tier == (int)ShardTier.Preview).Select(ms => ms.ShardId).ToList(),
            Original = ordered.Where(ms => ms.Tier == (int)ShardTier.Original).Select(ms => ms.ShardId).ToList()
        };
    }
}
