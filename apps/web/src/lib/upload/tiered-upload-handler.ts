import { createLogger } from '../logger';
import { stripExifFromBlob } from '../exif-stripper';
import {
  getThumbnailQualityValue,
  shouldStoreOriginalsAsAvif,
  shouldStripExifFromOriginals,
} from '../settings-service';
import { getCryptoClient } from '../crypto-client';
import { generateThumbnail, generateTieredImages } from '../thumbnail-generator';
import { taskIdentity } from '../upload-errors';
import type { TieredShardIds } from '../../workers/types';
import type {
  UploadTask,
  PersistedTask,
  UploadHandlerContext,
} from './types';
import { uint8ArrayToBase64 } from './types';

const log = createLogger('TieredUploadHandler');

const FAIL_CLOSED_STRIP_REASONS = new Set([
  'unsupported-mime',
  'wasm-strip-failed',
  'malformed-jpeg',
  'malformed-png',
  'malformed-webp',
  'malformed-avif',
  'malformed-heic',
  'malformed-video',
]);

function unsupportedStripReasonForMimeType(mimeType: string): string | null {
  if (
    mimeType !== 'image/jpeg'
    && mimeType !== 'image/jpg'
    && mimeType !== 'image/pjpeg'
    && mimeType !== 'image/png'
    && mimeType !== 'image/webp'
    && mimeType !== 'image/heic'
    && mimeType !== 'image/heif'
    && mimeType !== 'image/avif'
    && !mimeType.startsWith('video/')
  ) {
    return 'unsupported-mime';
  }
  return null;
}

function stripRejectionMessage(reason: string, mimeType: string): string {
  switch (reason) {
    case 'unsupported-mime':
      return `Upload rejected: metadata stripping is unsupported for ${mimeType} originals.`;
    case 'wasm-strip-failed':
      return 'Upload rejected: metadata stripping failed before encryption.';
    case 'malformed-jpeg':
    case 'malformed-png':
    case 'malformed-webp':
    case 'malformed-avif':
    case 'malformed-heic':
    case 'malformed-video':
      return `Upload rejected: malformed ${mimeType} original cannot be safely stripped.`;
    default:
      return `Upload rejected: metadata stripping did not complete for ${mimeType} originals.`;
  }
}

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
    const crypto = await getCryptoClient();

    const stripOriginalMetadata = shouldStripExifFromOriginals();
    const storeOriginalAsAvif = shouldStoreOriginalsAsAvif();
    const sourceMimeType = (task.file.type || 'application/octet-stream').trim().toLowerCase();

    if (stripOriginalMetadata && !storeOriginalAsAvif) {
      const unsupportedReason = unsupportedStripReasonForMimeType(sourceMimeType);
      if (unsupportedReason !== null) {
        throw new Error(stripRejectionMessage(unsupportedReason, sourceMimeType));
      }
    }

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

    // Strip metadata only when preserving the source original. Canvas-generated
    // AVIF originals are freshly encoded and do not carry source metadata.
    if (stripOriginalMetadata && !storeOriginalAsAvif) {
      const originalMimeType = sourceMimeType;
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
        const skippedReason = stripResult.skippedReason ?? 'no-metadata-found';
        if (FAIL_CLOSED_STRIP_REASONS.has(skippedReason)) {
          throw new Error(stripRejectionMessage(skippedReason, originalMimeType));
        }
        log.info('EXIF stripping skipped for original tier', {
          mimeType: originalMimeType,
          sizeBefore,
          reason: skippedReason,
        });
      }
    }

    // Step 2: Encrypt the converted images
    task.currentAction = 'encrypting';
    ctx.onProgress?.(task);

    log.info('Starting encryption', taskIdentity(task));
    const [thumbnailEncrypted, previewEncrypted, originalEncrypted] =
      await Promise.all([
        crypto.encryptShardWithEpoch(
          task.epochHandleId,
          tieredImages.thumbnail.data,
          0,
          1,
        ),
        crypto.encryptShardWithEpoch(
          task.epochHandleId,
          tieredImages.preview.data,
          0,
          2,
        ),
        crypto.encryptShardWithEpoch(
          task.epochHandleId,
          tieredImages.original.data,
          0,
          3,
        ),
      ]);
    log.info('Tiered shards encrypted successfully', taskIdentity(task));

    // Extract dimensions and thumbnail for manifest
    log.info('Extracting dimensions for manifest', taskIdentity(task));
    task.originalWidth = tieredImages.originalWidth;
    task.originalHeight = tieredImages.originalHeight;
    task.thumbWidth = tieredImages.thumbnail.width;
    task.thumbHeight = tieredImages.thumbnail.height;

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
      thumbnailEncrypted.envelopeBytes,
      thumbnailEncrypted.sha256,
      0,
    );
    log.info('Thumbnail shard uploaded', {
      ...taskIdentity(task),
      shardId: thumbShardId,
    });
    task.completedShards.push({
      index: 0,
      shardId: thumbShardId,
      sha256: thumbnailEncrypted.sha256,
      tier: 1,
    });
    task.progress = 0.33;
    ctx.onProgress?.(task);

    // Upload preview shard (tier 2)
    log.debug('Uploading preview shard', taskIdentity(task));
    const previewShardId = await ctx.tusUpload(
      task.albumId,
      previewEncrypted.envelopeBytes,
      previewEncrypted.sha256,
      0,
    );
    task.completedShards.push({
      index: 0,
      shardId: previewShardId,
      sha256: previewEncrypted.sha256,
      tier: 2,
    });
    task.progress = 0.66;
    ctx.onProgress?.(task);

    // Upload original shard (tier 3)
    log.debug('Uploading original shard', taskIdentity(task));
    const originalShardId = await ctx.tusUpload(
      task.albumId,
      originalEncrypted.envelopeBytes,
      originalEncrypted.sha256,
      0,
    );
    task.completedShards.push({
      index: 0,
      shardId: originalShardId,
      sha256: originalEncrypted.sha256,
      tier: 3,
    });
    task.progress = 1;
    ctx.onProgress?.(task);

    // Build tiered shard IDs for manifest
    const tieredShards: TieredShardIds = {
      thumbnail: {
        shardId: thumbShardId,
        sha256: thumbnailEncrypted.sha256,
      },
      preview: {
        shardId: previewShardId,
        sha256: previewEncrypted.sha256,
      },
      original: [
        {
          shardId: originalShardId,
          sha256: originalEncrypted.sha256,
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
      tieredShards,
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
