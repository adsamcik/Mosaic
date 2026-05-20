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
  // v1.0.1 release-blocker `v101-upload-pipeline-cross-format-regression`:
  // shard IDs are server-allocated UUIDs but appear in two equivalent
  // string forms across the pipeline. The TUS upload completion path
  // extracts the ID from the Location header (`/api/v1/files/{id}`) where
  // it arrives without dashes, which is what gets persisted into the
  // encrypted `PhotoMeta.shardIds` and bound into the signed transcript.
  // The `/albums/{id}/sync` projection, however, serializes shard IDs as
  // canonical dashed UUIDs (default System.Guid -> JSON behavior). Both
  // forms refer to the same UUID, and the signature itself stays
  // self-consistent because the same form is used at sign and verify
  // time. The cross-payload structural check must therefore compare the
  // canonical-byte representation, not the raw string, otherwise every
  // freshly uploaded photo gets rejected as `transcript-mismatch` and
  // never appears in the gallery.
  return signedShardIds.every((shardId, index) => uuidsEqual(shardId, shardIds[index]!));
}

function uuidsEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const aNorm = canonicalUuidHexOrNull(a);
  if (aNorm === null) {
    return false;
  }
  const bNorm = canonicalUuidHexOrNull(b);
  if (bNorm === null) {
    return false;
  }
  return aNorm === bNorm;
}

function canonicalUuidHexOrNull(value: string): string | null {
  const stripped = value.replace(/-/g, '').toLowerCase();
  if (stripped.length !== 32) {
    return null;
  }
  for (let i = 0; i < stripped.length; i += 1) {
    const code = stripped.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isHexLower = code >= 97 && code <= 102;
    if (!isDigit && !isHexLower) {
      return null;
    }
  }
  return stripped;
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
