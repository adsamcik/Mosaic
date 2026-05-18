import type { getCryptoClient } from '../crypto-client';
import { computeContentHashStreaming, DuplicateUploadError } from '../content-hash';
import type { UploadTask, UploadHandlerContext } from './types';
import { CHUNK_SIZE } from './types';
import { encryptUploadShardWithEpochHandle } from './encrypt-upload-shard';

/**
 * Process legacy upload for non-image files.
 * Uploads file as chunks of original shards only.
 */
export async function processLegacyUpload(
  task: UploadTask,
  crypto: Awaited<ReturnType<typeof getCryptoClient>>,
  ctx: UploadHandlerContext,
): Promise<void> {
  // CONTRACT: see docs/specs/SPEC-UploadContentHash.md. The bytes hashed here
  // MUST be the source-of-truth user file bytes (BEFORE any transformation).
  // Adding any per-tier transform between the source bytes and this call is
  // a v1 protocol break.
  //
  // v1.0.x s47-y1: stream the hash slice-by-slice so multi-GB files
  // don't allocate one giant ArrayBuffer.
  // v1.0.x s47-y2: per-chunk slices in the upload loop already re-read
  // from the File handle, so we never need to retain the full plaintext
  // beyond the streaming hasher.
  const contentHash = await computeContentHashStreaming(task.file);
  task.contentHash = contentHash;
  await ctx.updatePersistedTask(task.id, { contentHash });
  const duplicate = await ctx.contentHashDedup?.lookup(task.albumId, contentHash);
  if (duplicate) {
    throw new DuplicateUploadError(task.albumId, contentHash, duplicate.photoId, duplicate.dateAdded);
  }

  const totalChunks = Math.ceil(task.file.size / CHUNK_SIZE);
  const shardIds: string[] = new Array(totalChunks);

  for (let i = 0; i < totalChunks; i++) {
    // Check if this shard was already uploaded (resume support)
    const existing = task.completedShards.find((s) => s.index === i);
    if (existing) {
      shardIds[i] = existing.shardId;
      continue;
    }

    // Read chunk from file
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, task.file.size);
    const chunk = await task.file.slice(start, end).arrayBuffer();

    // Encrypt the chunk
    task.currentAction = 'encrypting';
    ctx.onProgress?.(task);

    const encrypted = await encryptUploadShardWithEpochHandle(
      crypto,
      task.epochHandleId,
      new Uint8Array(chunk),
      3,
      i,
    );

    // Upload via Tus resumable protocol
    task.currentAction = 'uploading';
    ctx.onProgress?.(task);
    const shardId = await ctx.tusUpload(
      task.albumId,
      encrypted.envelopeBytes,
      encrypted.sha256,
      i,
    );
    shardIds[i] = shardId;

    // Persist progress for resume (including hash for integrity verification)
    task.completedShards.push({
      index: i,
      shardId,
      sha256: encrypted.sha256,
      tier: 3,
    });
    await ctx.updatePersistedTask(task.id, {
      completedShards: task.completedShards,
    });

    // Update progress
    task.progress = (i + 1) / totalChunks;
    ctx.onProgress?.(task);
  }

  // Mark complete
  task.status = 'complete';
  task.currentAction = 'finalizing';
  ctx.onProgress?.(task);

  await ctx.updatePersistedTask(task.id, { status: 'complete' });
  await ctx.onComplete?.(task, shardIds);
  if (task.contentHash) {
    await ctx.contentHashDedup?.record(task.albumId, task.contentHash, task.id);
  }
}
