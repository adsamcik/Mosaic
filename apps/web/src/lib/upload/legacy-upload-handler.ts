import type { getCryptoClient } from '../crypto-client';
import type { UploadTask, UploadHandlerContext } from './types';
import { CHUNK_SIZE } from './types';

/**
 * Process legacy upload for non-image files.
 * Uploads file as chunks of original shards only.
 */
export async function processLegacyUpload(
  task: UploadTask,
  crypto: Awaited<ReturnType<typeof getCryptoClient>>,
  ctx: UploadHandlerContext,
): Promise<void> {
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

    const encrypted = await crypto.encryptShard(
      new Uint8Array(chunk),
      task.readKey,
      task.epochId,
      i,
    );

    // Upload via Tus resumable protocol
    task.currentAction = 'uploading';
    ctx.onProgress?.(task);
    const shardId = await ctx.tusUpload(
      task.albumId,
      encrypted.ciphertext,
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
  ctx.onComplete?.(task, shardIds);
}
