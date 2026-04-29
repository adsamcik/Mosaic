import { createLogger } from '../logger';
import { stripExifFromBlob } from '../exif-stripper';
import {
  getThumbnailQualityValue,
  shouldStoreOriginalsAsAvif,
  shouldStripExifFromOriginals,
} from '../settings-service';
import {
  generateThumbnail,
  generateTieredImages,
  encryptTieredImages,
} from '../thumbnail-generator';
import { taskIdentity } from '../upload-errors';
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
  log.info('processTieredUpload started', taskIdentity(task));
  try {
    // Import deriveTierKeys to construct full EpochKey
    const { deriveTierKeys } = await import('@mosaic/crypto');
    log.info('deriveTierKeys imported successfully', taskIdentity(task));

    // Derive tier keys from epochSeed (stored as readKey)
    const tierKeys = deriveTierKeys(task.readKey);
    log.info('Tier keys derived successfully', taskIdentity(task));

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

    log.info('Starting image conversion', taskIdentity(task));
    const tieredImages = await generateTieredImages(task.file);
    log.info('Images converted', {
      ...taskIdentity(task),
      thumbWidth: tieredImages.thumbnail.width,
      thumbHeight: tieredImages.thumbnail.height,
      previewWidth: tieredImages.preview.width,
      previewHeight: tieredImages.preview.height,
      originalWidth: tieredImages.originalWidth,
      originalHeight: tieredImages.originalHeight,
    });

    // H5: Strip EXIF / IPTC metadata from the original-tier bytes before
    // encryption. The thumbnail and preview tiers are always re-encoded
    // through canvas (AVIF), which sheds EXIF naturally. The original tier
    // can be JPEG passthrough (when the user prefers `preserve` format),
    // which would otherwise leak GPS, device serial, and timestamps to
    // anyone with a share link. Stripping is opt-out via settings.
    //
    // Format-coverage gap: only JPEG is stripped today. HEIC, PNG, WebP,
    // and AVIF originals are passed through unchanged (the stripper marks
    // them with skippedReason='unsupported-mime'). See exif-stripper.ts
    // for the full rationale and follow-up plan.
    if (shouldStripExifFromOriginals()) {
      const originalMimeType = shouldStoreOriginalsAsAvif()
        ? 'image/avif'
        : task.file.type || 'application/octet-stream';
      const sizeBefore = tieredImages.original.data.byteLength;
      const stripResult = await stripExifFromBlob(
        new Blob([new Uint8Array(tieredImages.original.data)]),
        originalMimeType,
      );
      if (stripResult.stripped) {
        tieredImages.original.data = stripResult.bytes;
        log.info('Stripped EXIF from original tier', {
          mimeType: originalMimeType,
          sizeBefore,
          sizeAfter: stripResult.bytes.byteLength,
        });
      } else {
        log.info('EXIF stripping skipped for original tier', {
          mimeType: originalMimeType,
          sizeBefore,
          reason: stripResult.skippedReason ?? 'no-metadata-found',
        });
      }
    }

    // Step 2: Encrypt the converted images
    task.currentAction = 'encrypting';
    ctx.onProgress?.(task);

    log.info('Starting encryption', taskIdentity(task));
    const tieredResult = await encryptTieredImages(tieredImages, epochKey, 0);
    log.info('Tiered shards encrypted successfully', taskIdentity(task));

    // Extract dimensions and thumbnail for manifest
    log.info('Extracting dimensions for manifest', taskIdentity(task));
    task.originalWidth = tieredResult.originalWidth;
    task.originalHeight = tieredResult.originalHeight;
    task.thumbWidth = tieredResult.thumbnail.width;
    task.thumbHeight = tieredResult.thumbnail.height;

    // Generate base64 thumbnail for embedded manifest preview
    // Use the thumbnail data before encryption for fast gallery loading
    log.info('Generating base64 thumbnail for manifest', taskIdentity(task));
    try {
      const quality = getThumbnailQualityValue();
      const thumbResult = await generateThumbnail(task.file, { quality });
      task.thumbnailBase64 = uint8ArrayToBase64(thumbResult.data);
      task.thumbhash = thumbResult.thumbhash;
      log.info('Base64 thumbnail generated successfully', taskIdentity(task));
    } catch (thumbError) {
      log.error(
        'Thumbnail generation for manifest failed',
        thumbError,
        taskIdentity(task),
      );
    }

    // Step 3: Upload all three tiers
    log.info('Setting task action to uploading', taskIdentity(task));
    task.currentAction = 'uploading';
    ctx.onProgress?.(task);

    // Upload thumbnail shard (tier 1)
    log.info('Starting TUS upload', taskIdentity(task));
    const thumbShardId = await ctx.tusUpload(
      task.albumId,
      tieredResult.thumbnail.encrypted.ciphertext,
      tieredResult.thumbnail.encrypted.sha256,
      0,
    );
    log.info('Thumbnail shard uploaded', {
      ...taskIdentity(task),
      shardId: thumbShardId,
    });
    task.completedShards.push({
      index: 0,
      shardId: thumbShardId,
      sha256: tieredResult.thumbnail.encrypted.sha256,
      tier: 1,
    });
    task.progress = 0.33;
    ctx.onProgress?.(task);

    // Upload preview shard (tier 2)
    log.debug('Uploading preview shard', taskIdentity(task));
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
    log.debug('Uploading original shard', taskIdentity(task));
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
    log.info('Tiered upload complete', {
      ...taskIdentity(task),
      shardIds,
    });
    await ctx.onComplete?.(task, shardIds, tieredShards);
  } catch (error) {
    log.error('processTieredUpload failed', error, taskIdentity(task));
    throw error;
  }
}
