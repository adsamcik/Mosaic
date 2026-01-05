import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { getApi, toBase64 } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import { getCurrentOrFetchEpochKey } from '../lib/epoch-key-service';
import { type EpochKeyBundle } from '../lib/epoch-key-store';
import { createLogger } from '../lib/logger';
import { syncEngine } from '../lib/sync-engine';
import { uploadQueue, type UploadTask } from '../lib/upload-queue';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('UploadContext');

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

/** Upload context value */
interface UploadContextValue {
  /** Whether an upload is currently in progress */
  isUploading: boolean;
  /** Upload progress (0-100) */
  progress: number;
  /** Current error, if any */
  error: UploadError | null;
  /** Upload a file to an album */
  upload: (file: File, albumId: string) => Promise<void>;
  /** Clear the current error */
  clearError: () => void;
  /** List of currently active upload tasks */
  activeTasks: UploadTask[];
}

const UploadContext = createContext<UploadContextValue | null>(null);

/**
 * Create a manifest after all shards are uploaded.
 * This ties the uploaded shards together and makes the photo visible.
 */
async function createManifestForUpload(
  task: UploadTask,
  shardIds: string[],
  epochKey: EpochKeyBundle
): Promise<void> {
  const crypto = await getCryptoClient();
  const api = getApi();

  // Build shard hashes array (in order of shard index)
  const sortedShards = [...task.completedShards].sort((a, b) => a.index - b.index);
  const shardHashes = sortedShards.map((s) => s.sha256);

  // Build photo metadata
  const now = new Date().toISOString();
  const photoMeta: PhotoMeta = {
    id: globalThis.crypto.randomUUID(),
    assetId: task.id,
    albumId: task.albumId,
    filename: task.file.name,
    mimeType: task.file.type || 'application/octet-stream',
    width: 0,
    height: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    shardIds: shardIds,
    shardHashes: shardHashes,
    epochId: task.epochId,
    ...(task.thumbnailBase64 && { thumbnail: task.thumbnailBase64 }),
    ...(task.thumbWidth && { thumbWidth: task.thumbWidth }),
    ...(task.thumbHeight && { thumbHeight: task.thumbHeight }),
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

  // DEBUG: Log the signing key details
  log.debug('Creating manifest with signing key', {
    epochId: epochKey.epochId,
    signerPubkeyPrefix: Array.from(signerPubkey.slice(0, 8)).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
    signaturePrefix: Array.from(signature.slice(0, 8)).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
    ciphertextLength: encrypted.ciphertext.length,
  });

  // Create manifest via API
  await api.createManifest({
    albumId: task.albumId,
    encryptedMeta: toBase64(encrypted.ciphertext),
    signature: toBase64(signature),
    signerPubkey: toBase64(signerPubkey),
    shardIds: shardIds,
  });
}

interface UploadProviderProps {
  children: ReactNode;
}

/**
 * Provider component for upload functionality.
 * Wraps components that need access to upload state and actions.
 */
export function UploadProvider({ children }: UploadProviderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const [activeTasks, setActiveTasks] = useState<UploadTask[]>([]);

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
        log.debug(`Fetching epoch key for album ${albumId}`);
        epochKey = await getCurrentOrFetchEpochKey(albumId);
        log.debug(`Got epoch key for album ${albumId}, epochId=${epochKey.epochId}`);
      } catch (err) {
        log.error(`Failed to get epoch key for album ${albumId}:`, {
          error: err instanceof Error ? err.message : String(err),
          errorName: err instanceof Error ? err.name : 'unknown',
          cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
        });
        const uploadError = new UploadError(
          `Failed to get epoch key for album: ${err instanceof Error ? err.message : String(err)}`,
          UploadErrorCode.EPOCH_KEY_FAILED,
          err instanceof Error ? err : undefined
        );
        setError(uploadError);
        setIsUploading(false);
        throw uploadError;
      }

      // Set up progress callback (convert 0-1 to 0-100)
      uploadQueue.onProgress = (task) => {
        setProgress(Math.round(task.progress * 100));
        setActiveTasks((prev) => {
          const index = prev.findIndex((t) => t.id === task.id);
          if (index === -1) return [...prev, task];
          const next = [...prev];
          next[index] = task;
          return next;
        });
      };

      // Create manifest when upload completes
      uploadQueue.onComplete = async (task, shardIds) => {
        // Remove from active tasks
        setActiveTasks((prev) => prev.filter((t) => t.id !== task.id));

        try {
          await createManifestForUpload(task, shardIds, epochKey);
          
          // Sync to pull the newly created manifest into local DB
          log.info(`Upload complete, syncing album ${task.albumId}`);
          try {
            await syncEngine.sync(task.albumId, epochKey.epochSeed);
            log.info(`Post-upload sync complete for album ${task.albumId}`);
          } catch (syncErr) {
            // Non-fatal: photo was uploaded, sync will happen later
            log.warn('Post-upload sync failed (photo still uploaded):', {
              error: syncErr instanceof Error ? syncErr.message : String(syncErr),
            });
          }
          
          setIsUploading(false);
          setProgress(100);
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



      uploadQueue.onError = (task, uploadErr) => {
        // Remove from active tasks
        setActiveTasks((prev) => prev.filter((t) => t.id !== task.id));

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
      
      // Add to active tasks immediately
      // We need to fetch the task object back from the queue or construct a minimal one
      // For now, let's wait for the first progress update or fetch pending tasks
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

  return (
    <UploadContext.Provider
      value={{ isUploading, progress, error, upload, clearError, activeTasks }}
    >
      {children}
    </UploadContext.Provider>
  );
}

/**
 * Hook to access upload context.
 * Must be used within an UploadProvider.
 */
export function useUploadContext(): UploadContextValue {
  const context = useContext(UploadContext);
  if (!context) {
    throw new Error('useUploadContext must be used within an UploadProvider');
  }
  return context;
}
