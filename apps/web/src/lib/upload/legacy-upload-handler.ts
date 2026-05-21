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
    // Check if this shard was already uploaded (resume support).
    //
    // v1.0.1 isolated-v3-08 / security-review-2026-05-21 MED: a stale
    // resume record from before commit 773e7d95 may be missing the
    // encrypted-envelope `contentLength` / `envelopeVersion`. The
    // manifest finalize builder falls back to `task.file.size`
    // (plaintext size) for missing contentLength, which the backend
    // rejects with HTTP 400 ("tieredShards contentLength does not
    // match stored shard length"). Re-uploading the shard captures
    // the correct length fresh and unblocks finalize.
    const existing = task.completedShards.find((s) => s.index === i);
    const hasFinalizableMetadata =
      existing !== undefined &&
      typeof existing.contentLength === 'number' &&
      existing.contentLength > 0 &&
      typeof existing.envelopeVersion === 'number';
    if (existing && hasFinalizableMetadata) {
      shardIds[i] = existing.shardId;
      continue;
    }
    if (existing && !hasFinalizableMetadata) {
      // Drop the stale record before re-uploading so the fresh shard
      // is persisted with full envelope metadata.
      task.completedShards = task.completedShards.filter((s) => s.index !== i);
      await ctx.updatePersistedTask(task.id, {
        completedShards: task.completedShards,
      });
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

    // Persist progress for resume (including hash for integrity verification).
    // contentLength / envelopeVersion are required for finalize: the backend
    // compares them against the stored shard's stored byte length. Defaulting
    // to task.file.size in the finalize builder yields the *plaintext* size,
    // which mismatches the encrypted envelope (header + ciphertext + AEAD tag)
    // and triggers a 400 ("tieredShards contentLength does not match stored
    // shard length"). This path is also the video frame-extraction fallback
    // (see processVideoUpload), so videos that fail container inspection
    // would otherwise fail to finalize. (v1.0.1 isolated-v2-05)
    task.completedShards.push({
      index: i,
      shardId,
      sha256: encrypted.sha256,
      tier: 3,
      contentLength: encrypted.envelopeBytes.byteLength,
      envelopeVersion: 3,
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
