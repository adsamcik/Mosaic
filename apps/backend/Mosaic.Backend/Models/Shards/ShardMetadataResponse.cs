using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Models.Shards;

public record ShardMetadataResponse(
    Guid Id,
    long SizeBytes,
    ShardStatus Status,
    DateTime StatusUpdatedAt,
    string? Sha256);
