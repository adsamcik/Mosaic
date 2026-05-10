import type {
  ManifestTranscriptInput,
  ManifestTranscriptShard,
  PhotoMeta,
} from '../workers/types';

interface FinalizeShardLike {
  readonly shardId: string;
  readonly tier: number;
  readonly shardIndex: number;
  readonly sha256: string;
}

export function manifestTranscriptInputForFinalize(input: {
  readonly albumId: string;
  readonly epochId: number;
  readonly encryptedMeta: Uint8Array;
  readonly tieredShards: readonly FinalizeShardLike[];
}): ManifestTranscriptInput {
  return {
    albumId: input.albumId,
    epochId: input.epochId,
    encryptedMeta: input.encryptedMeta,
    shards: transcriptShardsFromFinalize(input.tieredShards),
  };
}

export function manifestTranscriptInputForPhotoMeta(
  photo: PhotoMeta,
  encryptedMeta: Uint8Array,
): ManifestTranscriptInput {
  const shardIds = photo.shardIds ?? [];
  const shardHashes = photo.shardHashes ?? [];
  if (shardIds.length === 0) {
    throw new Error(`Manifest ${photo.id} has no shard IDs for signature verification`);
  }
  if (shardHashes.length !== shardIds.length) {
    throw new Error(`Manifest ${photo.id} has mismatched shard IDs and hashes`);
  }

  const originalShardIds = new Set(photo.originalShardIds ?? []);
  return {
    albumId: photo.albumId,
    epochId: photo.epochId,
    encryptedMeta,
    shards: shardIds.map((shardId, chunkIndex): ManifestTranscriptShard => ({
      chunkIndex,
      tier: tierForPhotoShard(photo, shardId, originalShardIds),
      shardId,
      sha256: shardHashes[chunkIndex]!,
    })),
  };
}

export function manifestShardIdsMatchTranscript(
  shardIds: readonly string[],
  input: ManifestTranscriptInput,
): boolean {
  const signedShardIds = [...input.shards]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((shard) => shard.shardId);
  if (signedShardIds.length !== shardIds.length) {
    return false;
  }
  return signedShardIds.every((shardId, index) => shardId === shardIds[index]);
}

function transcriptShardsFromFinalize(
  tieredShards: readonly FinalizeShardLike[],
): ManifestTranscriptShard[] {
  return [...tieredShards]
    .sort((a, b) => a.tier - b.tier || a.shardIndex - b.shardIndex)
    .map((shard, chunkIndex) => ({
      chunkIndex,
      tier: shard.tier,
      shardId: shard.shardId,
      sha256: shard.sha256,
    }));
}

function tierForPhotoShard(
  photo: PhotoMeta,
  shardId: string,
  originalShardIds: ReadonlySet<string>,
): number {
  if (photo.thumbnailShardId === shardId) {
    return 1;
  }
  if (photo.previewShardId === shardId && photo.previewShardId !== photo.thumbnailShardId) {
    return 2;
  }
  if (originalShardIds.has(shardId)) {
    return 3;
  }
  return 3;
}
