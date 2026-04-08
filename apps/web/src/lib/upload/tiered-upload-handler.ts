import { createLogger } from '../logger';
import { getThumbnailQualityValue } from '../settings-service';
import {
  generateThumbnail,
  generateTieredImages,
  encryptTieredImages,
} from '../thumbnail-generator';
import type { TieredShardIds } from '../../workers/types';
import type {
  UploadTask,
  PersistedTask,
  UploadHandlerContext,
} from './types';
import { uint8ArrayToBase64 } from './types';

const log = createLogger('TieredUploadHandler');

/**
 * Process tiered upload for image files.
 * Generates and uploads thumb, preview, and original shards.
 */
export async function processTieredUpload(
  task: UploadTask,
  ctx: UploadHandlerContext,
): Promise<void> {
  log.info(`processTieredUpload started for ${task.file.name}`);
  try {
    // Import deriveTierKeys to construct full EpochKey
    const { deriveTierKeys } = await import('@mosaic/crypto');
    log.info(`deriveTierKeys imported successfully`);

    // Derive tier keys from epochSeed (stored as readKey)
    const tierKeys = deriveTierKeys(task.readKey);
    log.info(`Tier keys derived successfully`);

    // Construct full EpochKey for encryption
    const epochKey = {
      epochId: task.epochId,
      epochSeed: task.readKey,
      thumbKey: tierKeys.thumbKey,
      previewKey: tierKeys.previewKey,
      fullKey: tierKeys.fullKey,
      // signKeypair not needed for encryption, provide empty placeholder
      signKeypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
      },
    };

    // Step 1: Convert image to tiered formats (thumb, preview, original)
    task.currentAction = 'converting';
    ctx.onProgress?.(task);

    log.info(`Starting image conversion for ${task.file.name}`);
    const tieredImages = await generateTieredImages(task.file);
    log.info(
      `Images converted: thumb=${tieredImages.thumbnail.width}x${tieredImages.thumbnail.height}, preview=${tieredImages.preview.width}x${tieredImages.preview.height}, original=${tieredImages.originalWidth}x${tieredImages.originalHeight}`,
    );

    // Step 2: Encrypt the converted images
    task.currentAction = 'encrypting';
    ctx.onProgress?.(task);

    log.info(`Starting encryption for ${task.file.name}`);
    const tieredResult = await encryptTieredImages(tieredImages, epochKey, 0);
    log.info(`Tiered shards encrypted successfully`);

    // Extract dimensions and thumbnail for manifest
    log.info(`Extracting dimensions for manifest`);
    task.originalWidth = tieredResult.originalWidth;
    task.originalHeight = tieredResult.originalHeight;
    task.thumbWidth = tieredResult.thumbnail.width;
    task.thumbHeight = tieredResult.thumbnail.height;

    // Generate base64 thumbnail for embedded manifest preview
    // Use the thumbnail data before encryption for fast gallery loading
    log.info(`Generating base64 thumbnail for manifest`);
    try {
      const quality = getThumbnailQualityValue();
      const thumbResult = await generateThumbnail(task.file, { quality });
      task.thumbnailBase64 = uint8ArrayToBase64(thumbResult.data);
      task.thumbhash = thumbResult.thumbhash;
      log.info(`Base64 thumbnail generated successfully`);
    } catch (thumbError) {
      log.error('Thumbnail generation for manifest failed', thumbError);
    }

    // Step 3: Upload all three tiers
    log.info(`Setting task action to uploading`);
    task.currentAction = 'uploading';
    ctx.onProgress?.(task);

    // Upload thumbnail shard (tier 1)
    log.info(`Starting TUS upload for ${task.file.name}`);
    const thumbShardId = await ctx.tusUpload(
      task.albumId,
      tieredResult.thumbnail.encrypted.ciphertext,
      tieredResult.thumbnail.encrypted.sha256,
      0,
    );
    log.info(`Thumbnail shard uploaded: ${thumbShardId}`);
    task.completedShards.push({
      index: 0,
      shardId: thumbShardId,
      sha256: tieredResult.thumbnail.encrypted.sha256,
      tier: 1,
    });
    task.progress = 0.33;
    ctx.onProgress?.(task);

    // Upload preview shard (tier 2)
    log.debug(`Uploading preview shard for ${task.file.name}`);
    const previewShardId = await ctx.tusUpload(
      task.albumId,
      tieredResult.preview.encrypted.ciphertext,
      tieredResult.preview.encrypted.sha256,
      0,
    );
    task.completedShards.push({
      index: 0,
      shardId: previewShardId,
      sha256: tieredResult.preview.encrypted.sha256,
      tier: 2,
    });
    task.progress = 0.66;
    ctx.onProgress?.(task);

    // Upload original shard (tier 3)
    log.debug(`Uploading original shard for ${task.file.name}`);
    const originalShardId = await ctx.tusUpload(
      task.albumId,
      tieredResult.original.encrypted.ciphertext,
      tieredResult.original.encrypted.sha256,
      0,
    );
    task.completedShards.push({
      index: 0,
      shardId: originalShardId,
      sha256: tieredResult.original.encrypted.sha256,
      tier: 3,
    });
    task.progress = 1;
    ctx.onProgress?.(task);

    // Build tiered shard IDs for manifest
    const tieredShards: TieredShardIds = {
      thumbnail: {
        shardId: thumbShardId,
        sha256: tieredResult.thumbnail.encrypted.sha256,
      },
      preview: {
        shardId: previewShardId,
        sha256: tieredResult.preview.encrypted.sha256,
      },
      original: [
        {
          shardId: originalShardId,
          sha256: tieredResult.original.encrypted.sha256,
        },
      ],
    };
    task.tieredShards = tieredShards;

    // Persist and complete - only include defined values to satisfy exactOptionalPropertyTypes
    const persistedUpdate: Partial<PersistedTask> = {
      status: 'complete',
      completedShards: task.completedShards,
      thumbWidth: task.thumbWidth,
      thumbHeight: task.thumbHeight,
      originalWidth: task.originalWidth,
      originalHeight: task.originalHeight,
    };
    if (task.thumbnailBase64)
      persistedUpdate.thumbnailBase64 = task.thumbnailBase64;
    if (task.thumbhash) persistedUpdate.thumbhash = task.thumbhash;
    if (task.videoMetadata)
      persistedUpdate.videoMetadata = task.videoMetadata;

    await ctx.updatePersistedTask(task.id, persistedUpdate);

    task.status = 'complete';
    task.currentAction = 'finalizing';
    ctx.onProgress?.(task);

    // Legacy shardIds for backward compatibility
    const shardIds = [thumbShardId, previewShardId, originalShardId];
    log.info(
      `Tiered upload complete for ${task.file.name}: ${shardIds.join(', ')}`,
    );
    ctx.onComplete?.(task, shardIds, tieredShards);
  } catch (error) {
    log.error(`processTieredUpload failed for ${task.file.name}:`, error);
    throw error;
  }
}
