import { useCallback, useState } from 'react';
import { getCurrentOrFetchEpochKey } from '../lib/epoch-key-service';
import { type EpochKeyBundle } from '../lib/epoch-key-store';
import { uploadQueue, type UploadTask } from '../lib/upload-queue';
import { getCryptoClient } from '../lib/crypto-client';
import { getApi, toBase64 } from '../lib/api';
import type { PhotoMeta, TieredShardIds } from '../workers/types';
import { createLogger } from '../lib/logger';

const log = createLogger('useUpload');

/** Error thrown when upload fails */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: UploadErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Upload error codes */
export enum UploadErrorCode {
  /** Failed to get epoch key for album */
  EPOCH_KEY_FAILED = 'EPOCH_KEY_FAILED',
  /** Upload queue not initialized */
  QUEUE_NOT_INITIALIZED = 'QUEUE_NOT_INITIALIZED',
  /** Generic upload error */
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  /** Failed to create manifest after upload */
  MANIFEST_FAILED = 'MANIFEST_FAILED',
}

/**
 * Create a manifest after all shards are uploaded.
 * This ties the uploaded shards together and makes the photo visible.
 */
async function createManifestForUpload(
  task: UploadTask,
  shardIds: string[],
  epochKey: EpochKeyBundle,
  tieredShards?: TieredShardIds
): Promise<void> {
  const crypto = await getCryptoClient();
  const api = getApi();

  // Build shard hashes array (in order of shard index)
  const sortedShards = [...task.completedShards].sort((a, b) => a.index - b.index);
  const shardHashes = sortedShards.map((s) => s.sha256);

  // Build photo metadata with tier-specific shard IDs
  const now = new Date().toISOString();
  const photoMeta: PhotoMeta = {
    id: globalThis.crypto.randomUUID(),
    assetId: task.id,
    albumId: task.albumId,
    filename: task.file.name,
    mimeType: task.file.type || 'application/octet-stream',
    width: task.originalWidth ?? 0,
    height: task.originalHeight ?? 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    shardIds: shardIds, // Legacy: flat array for backward compatibility
    shardHashes: shardHashes, // For integrity verification during download
    epochId: task.epochId,
    // Only set optional fields if they have values
    ...(task.thumbnailBase64 && { thumbnail: task.thumbnailBase64 }),
    ...(task.thumbWidth && { thumbWidth: task.thumbWidth }),
    ...(task.thumbHeight && { thumbHeight: task.thumbHeight }),
    // New tier-specific shard IDs
    ...(tieredShards && {
      thumbnailShardId: tieredShards.thumbnail.shardId,
      thumbnailShardHash: tieredShards.thumbnail.sha256,
      previewShardId: tieredShards.preview.shardId,
      previewShardHash: tieredShards.preview.sha256,
      originalShardIds: tieredShards.original.map(s => s.shardId),
      originalShardHashes: tieredShards.original.map(s => s.sha256),
    }),
  };

  // Encrypt the manifest metadata
  const encrypted = await crypto.encryptManifest(
    photoMeta,
    epochKey.epochSeed,
    task.epochId
  );

  // Sign the encrypted manifest with the epoch signing key
  const signature = await crypto.signManifest(
    encrypted.ciphertext,
    epochKey.signKeypair.secretKey
  );

  // Get signer public key
  const signerPubkey = epochKey.signKeypair.publicKey;

  // Build tiered shard info for backend if available
  const tieredShardInfo = tieredShards ? [
    { shardId: tieredShards.thumbnail.shardId, tier: 1 },
    { shardId: tieredShards.preview.shardId, tier: 2 },
    ...tieredShards.original.map(s => ({ shardId: s.shardId, tier: 3 })),
  ] : undefined;

  // Create manifest via API
  await api.createManifest({
    albumId: task.albumId,
    encryptedMeta: toBase64(encrypted.ciphertext),
    signature: toBase64(signature),
    signerPubkey: toBase64(signerPubkey),
    shardIds: shardIds,
    // Send tier info to backend for new uploads
    ...(tieredShardInfo && { tieredShards: tieredShardInfo }),
  });
}

/**
 * Hook for file upload functionality
 */
export function useUpload() {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);

  const upload = useCallback(async (file: File, albumId: string) => {
    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Initialize upload queue if needed
      await uploadQueue.init();

      // Get the current epoch key for this album
      let epochKey: EpochKeyBundle;
      try {
        epochKey = await getCurrentOrFetchEpochKey(albumId);
      } catch (err) {
        const uploadError = new UploadError(
          `Failed to get epoch key for album: ${err instanceof Error ? err.message : String(err)}`,
          UploadErrorCode.EPOCH_KEY_FAILED,
          err instanceof Error ? err : undefined
        );
        setError(uploadError);
        setIsUploading(false);
        throw uploadError;
      }

      // Set up progress callback
      uploadQueue.onProgress = (task) => {
        setProgress(task.progress);
      };

      // Create manifest when upload completes
      uploadQueue.onComplete = async (task, shardIds, tieredShards) => {
        try {
          await createManifestForUpload(task, shardIds, epochKey, tieredShards);
          setIsUploading(false);
          setProgress(1);
        } catch (manifestErr) {
          log.error('Failed to create manifest:', manifestErr);
          setError(
            new UploadError(
              `Upload succeeded but manifest creation failed: ${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}`,
              UploadErrorCode.MANIFEST_FAILED,
              manifestErr instanceof Error ? manifestErr : undefined
            )
          );
          setIsUploading(false);
        }
      };

      uploadQueue.onError = (_, uploadErr) => {
        log.error('Upload failed:', uploadErr);
        setError(
          new UploadError(
            uploadErr.message,
            UploadErrorCode.UPLOAD_FAILED,
            uploadErr
          )
        );
        setIsUploading(false);
      };

      // Add file to queue with real epoch key
      await uploadQueue.add(
        file,
        albumId,
        epochKey.epochId,
        epochKey.epochSeed
      );
    } catch (err) {
      // Only handle errors not already handled above
      if (!(err instanceof UploadError)) {
        log.error('Upload error:', err);
        const uploadError = new UploadError(
          err instanceof Error ? err.message : String(err),
          UploadErrorCode.UPLOAD_FAILED,
          err instanceof Error ? err : undefined
        );
        setError(uploadError);
        setIsUploading(false);
      }
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { upload, isUploading, progress, error, clearError };
}
