import { createLogger } from '../logger';
import { getCryptoClient } from '../crypto-client';
import { extractVideoFrame } from '../video-frame-extractor';
import { taskIdentity } from '../upload-errors';
import type { TieredShardIds } from '../../workers/types';
import type {
  UploadTask,
  PersistedTask,
  CompletedShard,
  VideoUploadMetadata,
  UploadHandlerContext,
} from './types';
import { CHUNK_SIZE } from './types';
import { processLegacyUpload } from './legacy-upload-handler';

const log = createLogger('VideoUploadHandler');

/**
 * Process video upload — hybrid of tiered (thumbnail) and legacy (chunked original).
 *
 * 1. Extract a frame from the video → thumbnail (tier 1)
 * 2. Encrypt and upload the thumbnail shard
 * 3. Encrypt and upload the original video in 6MB chunks (tier 3)
 * 4. Build tiered shard references for manifest
 *
 * Falls back to legacy upload (no thumbnail) if frame extraction fails.
 */
export async function processVideoUpload(
  task: UploadTask,
  ctx: UploadHandlerContext,
): Promise<void> {
  log.info('processVideoUpload started', taskIdentity(task));

  // Step 1: Extract video frame + metadata (0-10% progress)
  task.currentAction = 'converting';
  task.progress = 0;
  ctx.onProgress?.(task);

  let frameResult: Awaited<ReturnType<typeof extractVideoFrame>>;
  try {
    frameResult = await extractVideoFrame(task.file);
    log.info('Video frame extracted', {
      ...taskIdentity(task),
      width: frameResult.metadata.width,
      height: frameResult.metadata.height,
      duration: frameResult.metadata.duration,
      codec: frameResult.metadata.codec ?? 'unknown',
    });
  } catch (frameError: unknown) {
    // Frame extraction failed — fall back to legacy chunked upload without thumbnail
    const errMsg = frameError instanceof Error ? frameError.message : String(frameError);
    log.warn('Video frame extraction failed; falling back to legacy upload', {
      ...taskIdentity(task),
      error: errMsg,
    });
    task.videoMetadata = {
      isVideo: true,
      duration: 0,
      width: task.originalWidth ?? 0,
      height: task.originalHeight ?? 0,
    };
    await ctx.updatePersistedTask(task.id, {
      videoMetadata: task.videoMetadata,
    });
    const crypto = await getCryptoClient();
    await processLegacyUpload(task, crypto, ctx);
    return;
  }

  task.progress = 0.1;
  ctx.onProgress?.(task);

  // Store video metadata on the task for manifest creation
  const videoMeta: VideoUploadMetadata = {
    isVideo: true,
    duration: frameResult.metadata.duration,
    width: frameResult.metadata.width,
    height: frameResult.metadata.height,
    thumbnail: frameResult.embeddedThumbnail,
    thumbWidth: frameResult.embeddedWidth,
    thumbHeight: frameResult.embeddedHeight,
    thumbhash: frameResult.thumbhash,
  };
  if (frameResult.metadata.codec) {
    videoMeta.videoCodec = frameResult.metadata.codec;
  }
  task.videoMetadata = videoMeta;

  // Also set top-level fields used by manifest-service
  task.originalWidth = frameResult.metadata.width;
  task.originalHeight = frameResult.metadata.height;
  task.thumbnailBase64 = frameResult.embeddedThumbnail;
  task.thumbWidth = frameResult.embeddedWidth;
  task.thumbHeight = frameResult.embeddedHeight;
  task.thumbhash = frameResult.thumbhash;

  try {
    const crypto = await getCryptoClient();

    // Step 2: Encrypt and upload thumbnail shard (10-20% progress)
    task.currentAction = 'encrypting';
    task.progress = 0.1;
    ctx.onProgress?.(task);

    // Convert thumbnail blob to Uint8Array
    const thumbBuffer = await frameResult.thumbnailBlob.arrayBuffer();
    const thumbData = new Uint8Array(thumbBuffer);

    log.info('Encrypting video thumbnail', {
      ...taskIdentity(task),
      thumbBytes: thumbData.byteLength,
    });
    const thumbEncrypted = await crypto.encryptShardWithEpoch(
      task.epochHandleId,
      thumbData,
      0,
      1,
    );

    task.currentAction = 'uploading';
    task.progress = 0.15;
    ctx.onProgress?.(task);

    const thumbShardId = await ctx.tusUpload(
      task.albumId,
      thumbEncrypted.envelopeBytes,
      thumbEncrypted.sha256,
      0,
    );
    log.info('Video thumbnail shard uploaded', {
      ...taskIdentity(task),
      shardId: thumbShardId,
    });

    task.completedShards.push({
      index: 0,
      shardId: thumbShardId,
      sha256: thumbEncrypted.sha256,
      tier: 1,
    });
    task.progress = 0.2;
    ctx.onProgress?.(task);

    // Step 3: Encrypt and upload original video in chunks (20-95% progress)
    const totalChunks = Math.ceil(task.file.size / CHUNK_SIZE);
    const originalShards: CompletedShard[] = [];

    for (let i = 0; i < totalChunks; i++) {
      // Read chunk from file using slice (avoids loading entire video into memory)
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, task.file.size);
      const chunk = await task.file.slice(start, end).arrayBuffer();

      // Encrypt the chunk with fullKey (tier 3)
      task.currentAction = 'encrypting';
      ctx.onProgress?.(task);

      const chunkEncrypted = await crypto.encryptShardWithEpoch(
        task.epochHandleId,
        new Uint8Array(chunk),
        i,
        3,
      );

      // Upload via Tus
      task.currentAction = 'uploading';
      ctx.onProgress?.(task);

      const chunkShardId = await ctx.tusUpload(
        task.albumId,
        chunkEncrypted.envelopeBytes,
        chunkEncrypted.sha256,
        i,
      );

      const completedShard: CompletedShard = {
        index: i,
        shardId: chunkShardId,
        sha256: chunkEncrypted.sha256,
        tier: 3,
      };
      task.completedShards.push(completedShard);
      originalShards.push(completedShard);

      // Persist progress for resume
      await ctx.updatePersistedTask(task.id, {
        completedShards: task.completedShards,
        ...(task.videoMetadata ? { videoMetadata: task.videoMetadata } : {}),
      });

      // Scale progress: 20% to 95% across all chunks
      task.progress = 0.2 + ((i + 1) / totalChunks) * 0.75;
      ctx.onProgress?.(task);

      log.debug('Video chunk uploaded', {
        ...taskIdentity(task),
        chunkIndex: i + 1,
        totalChunks,
        shardId: chunkShardId,
      });
    }

    // Step 4: Build tiered shard references for manifest (95-100%)
    task.progress = 0.95;
    task.currentAction = 'finalizing';
    ctx.onProgress?.(task);

    const tieredShards: TieredShardIds = {
      thumbnail: {
        shardId: thumbShardId,
        sha256: thumbEncrypted.sha256,
      },
      // No preview tier for video Phase 1 — use thumbnail as placeholder
      preview: {
        shardId: thumbShardId,
        sha256: thumbEncrypted.sha256,
      },
      original: originalShards.map((s) => ({
        shardId: s.shardId,
        sha256: s.sha256,
      })),
    };
    task.tieredShards = tieredShards;

    // Persist completion
    const persistedUpdate: Partial<PersistedTask> = {
      status: 'complete',
      completedShards: task.completedShards,
      thumbWidth: task.thumbWidth,
      thumbHeight: task.thumbHeight,
      originalWidth: task.originalWidth,
      originalHeight: task.originalHeight,
      ...(task.videoMetadata ? { videoMetadata: task.videoMetadata } : {}),
    };
    if (task.thumbnailBase64) persistedUpdate.thumbnailBase64 = task.thumbnailBase64;
    if (task.thumbhash) persistedUpdate.thumbhash = task.thumbhash;

    await ctx.updatePersistedTask(task.id, persistedUpdate);

    task.status = 'complete';
    task.progress = 1;
    ctx.onProgress?.(task);

    // Legacy shardIds: thumbnail + all original chunks
    const allShardIds = [thumbShardId, ...originalShards.map((s) => s.shardId)];
    log.info('Video upload complete', {
      ...taskIdentity(task),
      shardCount: allShardIds.length,
      thumbnailShards: 1,
      originalChunks: originalShards.length,
    });
    await ctx.onComplete?.(task, allShardIds, tieredShards);
  } catch (error) {
    log.error('processVideoUpload failed', error, taskIdentity(task));
    throw error;
  }
}
