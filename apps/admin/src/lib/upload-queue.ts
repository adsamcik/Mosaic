import { openDB, type IDBPDatabase } from 'idb';
import * as tus from 'tus-js-client';
import { TUS_ENDPOINT } from './api';
import { getCryptoClient } from './crypto-client';
import { createLogger } from './logger';
import { getMimeType } from './mime-type-detection';
import { getThumbnailQualityValue } from './settings-service';
import {
  generateThumbnail,
  generateTieredImages,
  encryptTieredImages,
  isSupportedImageType,
} from './thumbnail-generator';
import type { TieredShardIds } from '../workers/types';

const log = createLogger('upload-queue');

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Chunk size for splitting files (6MB) */
const CHUNK_SIZE = 6 * 1024 * 1024;

/** Upload task status */
export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'complete'
  | 'error'
  | 'permanently_failed';
export type UploadAction =
  | 'pending'
  | 'converting'
  | 'encrypting'
  | 'uploading'
  | 'finalizing';

/** Maximum number of retry attempts before marking as permanently failed */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (1 second) */
const BASE_DELAY_MS = 1000;

/** Threshold for stale failed tasks (1 hour in milliseconds) */
const STALE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Calculate retry delay using exponential backoff
 * @param retryCount - Number of retries attempted (0-indexed)
 * @returns Delay in milliseconds (1s, 2s, 4s, 8s, ...)
 */
function getRetryDelay(retryCount: number): number {
  return BASE_DELAY_MS * Math.pow(2, retryCount);
}

/** Completed shard with ID and hash for integrity verification */
export interface CompletedShard {
  index: number;
  shardId: string;
  sha256: string; // Base64url hash for verification
  /** Shard tier: 1=thumb, 2=preview, 3=original */
  tier?: number;
}

/** Tiered shard result from upload (3 tiers) */
export interface TieredUploadResult {
  thumbnail: CompletedShard;
  preview: CompletedShard;
  original: CompletedShard[];
}

/** In-memory upload task */
export interface UploadTask {
  id: string;
  file: File;
  albumId: string;
  epochId: number;
  readKey: Uint8Array;
  status: UploadStatus;
  currentAction: UploadAction;
  progress: number;
  completedShards: CompletedShard[];
  error?: string;
  /** Number of retry attempts made */
  retryCount: number;
  /** Timestamp of the last attempt (for backoff calculation) */
  lastAttemptAt: number;
  /** Generated thumbnail base64 (set during upload) */
  thumbnailBase64?: string;
  /** Thumbnail width */
  thumbWidth?: number;
  /** Thumbnail height */
  thumbHeight?: number;
  /** Original image width */
  originalWidth?: number;
  /** Original image height */
  originalHeight?: number;
  /** ThumbHash string for instant placeholder (~25 bytes base64) */
  thumbhash?: string;
  /** Tiered shard IDs for the completed upload */
  tieredShards?: TieredShardIds;
  /** Detected MIME type from magic bytes (more reliable than file.type) */
  detectedMimeType?: string;
}

/** Persisted task state (for resume after reload) */
interface PersistedTask {
  id: string;
  albumId: string;
  fileName: string;
  fileSize: number;
  epochId: number;
  totalChunks: number;
  completedShards: CompletedShard[];
  status: string;
  /** Number of retry attempts made */
  retryCount: number;
  /** Timestamp of the last attempt */
  lastAttemptAt: number;
  /** Base64-encoded thumbnail (generated once, persisted for resume) */
  thumbnailBase64?: string;
  /** Thumbnail width */
  thumbWidth?: number;
  /** Thumbnail height */
  thumbHeight?: number;
  /** Original image width */
  originalWidth?: number;
  /** Original image height */
  originalHeight?: number;
  /** ThumbHash string for instant placeholder (~25 bytes base64) */
  thumbhash?: string;
}

/** IndexedDB schema */
interface UploadQueueDB {
  tasks: {
    key: string;
    value: PersistedTask;
  };
}

type ProgressCallback = (task: UploadTask) => void;
type CompleteCallback = (
  task: UploadTask,
  shardIds: string[],
  tieredShards?: TieredShardIds,
) => void;
type ErrorCallback = (task: UploadTask, error: Error) => void;

/**
 * Upload Queue Manager
 * Handles chunked, encrypted, resumable file uploads
 */
class UploadQueue {
  private queue: UploadTask[] = [];
  private processing = false;
  private maxConcurrent = 2;
  private activeCount = 0;
  private db: IDBPDatabase<UploadQueueDB> | null = null;

  /** Called when upload progress updates */
  onProgress?: ProgressCallback;

  /** Called when upload completes successfully */
  onComplete?: CompleteCallback;

  /** Called when upload fails */
  onError?: ErrorCallback;

  /**
   * Initialize the upload queue (call once on app start)
   */
  async init(): Promise<void> {
    this.db = await openDB<UploadQueueDB>('mosaic-upload-queue', 1, {
      upgrade(db) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      },
    });
  }

  /**
   * Add a file to the upload queue
   * @returns Task ID for tracking
   */
  async add(
    file: File,
    albumId: string,
    epochId: number,
    readKey: Uint8Array,
  ): Promise<string> {
    log.info(
      `UploadQueue.add called: file=${file.name}, albumId=${albumId}, epochId=${epochId}`,
    );
    if (!this.db) {
      log.error('Upload queue not initialized - db is null');
      throw new Error('Upload queue not initialized');
    }

    const taskId = crypto.randomUUID();
    log.info(`Created task ID: ${taskId}`);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Persist task state for resume support
    const persisted: PersistedTask = {
      id: taskId,
      albumId,
      fileName: file.name,
      fileSize: file.size,
      epochId,
      totalChunks,
      completedShards: [],
      status: 'queued',
      retryCount: 0,
      lastAttemptAt: 0,
    };
    await this.db.put('tasks', persisted);

    // Create in-memory task
    const task: UploadTask = {
      id: taskId,
      file,
      albumId,
      epochId,
      readKey,
      status: 'queued',
      currentAction: 'pending',
      progress: 0,
      completedShards: [],
      retryCount: 0,
      lastAttemptAt: 0,
    };

    this.queue.push(task);
    log.info(
      `Task ${taskId} pushed to queue, queue length: ${this.queue.length}, starting processQueue`,
    );
    void this.processQueue();

    return taskId;
  }

  /**
   * Get all pending/in-progress tasks (excludes complete and permanently failed)
   */
  async getPendingTasks(): Promise<PersistedTask[]> {
    if (!this.db) return [];

    const all = await this.db.getAll('tasks');
    return all.filter(
      (t) => t.status !== 'complete' && t.status !== 'permanently_failed',
    );
  }

  /**
   * Get all failed tasks (both temporary errors and permanently failed)
   */
  async getFailedTasks(): Promise<PersistedTask[]> {
    if (!this.db) return [];

    const all = await this.db.getAll('tasks');
    return all.filter(
      (t) => t.status === 'error' || t.status === 'permanently_failed',
    );
  }

  /**
   * Cancel an upload task
   */
  async cancel(taskId: string): Promise<void> {
    // Remove from queue
    const queueIndex = this.queue.findIndex((t) => t.id === taskId);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
    }

    // Remove from IndexedDB
    if (this.db) {
      await this.db.delete('tasks', taskId);
    }
  }

  private async processQueue(): Promise<void> {
    log.info(
      `processQueue called: processing=${this.processing}, queueLength=${this.queue.length}, activeCount=${this.activeCount}, maxConcurrent=${this.maxConcurrent}`,
    );
    if (this.processing) {
      log.info('processQueue: already processing, returning');
      return;
    }
    this.processing = true;

    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const task = this.queue.shift();
      if (!task) break;

      log.info(`processQueue: starting task ${task.id}`);
      this.activeCount++;
      this.processTask(task)
        .catch((err) => {
          log.error('Upload task failed:', err);
        })
        .finally(() => {
          this.activeCount--;
          void this.processQueue();
        });
    }

    this.processing = false;
  }

  private async processTask(task: UploadTask): Promise<void> {
    log.info(
      `Processing task ${task.id}: ${task.file.name} (${task.file.type}, ${task.file.size} bytes)`,
    );
    const crypto = await getCryptoClient();

    try {
      task.status = 'uploading';
      task.currentAction = 'pending';
      await this.updatePersistedTask(task.id, { status: 'uploading' });

      // Detect actual MIME type from file magic bytes
      // This is more reliable than file.type for formats like HEIC
      const detectedMimeType = await getMimeType(task.file);
      task.detectedMimeType = detectedMimeType;
      log.info(
        `Detected MIME type: ${detectedMimeType} (browser reported: ${task.file.type})`,
      );

      // Check if this is a supported image type for tiered upload
      if (isSupportedImageType(detectedMimeType)) {
        // New tiered upload flow - generates thumb, preview, and original shards
        log.info(`Using tiered upload for image: ${task.file.name}`);
        await this.processTieredUpload(task);
      } else {
        // Legacy flow for non-image files - single original shard
        log.info(`Using legacy upload for non-image: ${task.file.name}`);
        await this.processLegacyUpload(task, crypto);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const now = Date.now();

      task.retryCount++;
      task.lastAttemptAt = now;
      task.error = errorMessage;

      if (task.retryCount >= MAX_RETRIES) {
        // Max retries exceeded - mark as permanently failed
        task.status = 'permanently_failed';
        log.error(
          `Upload task ${task.id} permanently failed after ${MAX_RETRIES} retries:`,
          error,
        );

        await this.updatePersistedTask(task.id, {
          status: 'permanently_failed',
          retryCount: task.retryCount,
          lastAttemptAt: now,
        });

        this.onError?.(
          task,
          error instanceof Error ? error : new Error(errorMessage),
        );
      } else {
        // Schedule retry with exponential backoff
        const delay = getRetryDelay(task.retryCount - 1);
        log.warn(
          `Upload task ${task.id} failed (attempt ${task.retryCount}/${MAX_RETRIES}), retrying in ${delay}ms: ${errorMessage}`,
        );

        task.status = 'error';
        await this.updatePersistedTask(task.id, {
          status: 'error',
          retryCount: task.retryCount,
          lastAttemptAt: now,
        });

        this.onError?.(
          task,
          error instanceof Error ? error : new Error(errorMessage),
        );

        // Re-queue for retry after delay
        setTimeout(() => {
          task.status = 'queued';
          task.currentAction = 'pending';
          this.queue.push(task);
          void this.processQueue();
        }, delay);
      }
    }
  }

  /**
   * Process tiered upload for image files.
   * Generates and uploads thumb, preview, and original shards.
   */
  private async processTieredUpload(task: UploadTask): Promise<void> {
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
      this.onProgress?.(task);

      log.info(`Starting image conversion for ${task.file.name}`);
      const tieredImages = await generateTieredImages(task.file);
      log.info(
        `Images converted: thumb=${tieredImages.thumbnail.width}x${tieredImages.thumbnail.height}, preview=${tieredImages.preview.width}x${tieredImages.preview.height}, original=${tieredImages.originalWidth}x${tieredImages.originalHeight}`,
      );

      // Step 2: Encrypt the converted images
      task.currentAction = 'encrypting';
      this.onProgress?.(task);

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
      this.onProgress?.(task);

      // Upload thumbnail shard (tier 1)
      log.info(`Starting TUS upload for ${task.file.name}`);
      const thumbShardId = await this.tusUpload(
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
      this.onProgress?.(task);

      // Upload preview shard (tier 2)
      log.debug(`Uploading preview shard for ${task.file.name}`);
      const previewShardId = await this.tusUpload(
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
      this.onProgress?.(task);

      // Upload original shard (tier 3)
      log.debug(`Uploading original shard for ${task.file.name}`);
      const originalShardId = await this.tusUpload(
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
      this.onProgress?.(task);

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

      await this.updatePersistedTask(task.id, persistedUpdate);

      task.status = 'complete';
      task.currentAction = 'finalizing';
      this.onProgress?.(task);

      // Legacy shardIds for backward compatibility
      const shardIds = [thumbShardId, previewShardId, originalShardId];
      log.info(
        `Tiered upload complete for ${task.file.name}: ${shardIds.join(', ')}`,
      );
      this.onComplete?.(task, shardIds, tieredShards);
    } catch (error) {
      log.error(`processTieredUpload failed for ${task.file.name}:`, error);
      throw error;
    }
  }

  /**
   * Process legacy upload for non-image files.
   * Uploads file as chunks of original shards only.
   */
  private async processLegacyUpload(
    task: UploadTask,
    crypto: Awaited<ReturnType<typeof getCryptoClient>>,
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
      this.onProgress?.(task);

      const encrypted = await crypto.encryptShard(
        new Uint8Array(chunk),
        task.readKey,
        task.epochId,
        i,
      );

      // Upload via Tus resumable protocol
      task.currentAction = 'uploading';
      this.onProgress?.(task);
      const shardId = await this.tusUpload(
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
      await this.updatePersistedTask(task.id, {
        completedShards: task.completedShards,
      });

      // Update progress
      task.progress = (i + 1) / totalChunks;
      this.onProgress?.(task);
    }

    // Mark complete
    task.status = 'complete';
    task.currentAction = 'finalizing';
    this.onProgress?.(task);

    await this.updatePersistedTask(task.id, { status: 'complete' });
    this.onComplete?.(task, shardIds);
  }

  private async updatePersistedTask(
    id: string,
    updates: Partial<PersistedTask>,
  ): Promise<void> {
    if (!this.db) return;

    const task = await this.db.get('tasks', id);
    if (task) {
      Object.assign(task, updates);
      await this.db.put('tasks', task);
    }
  }

  /**
   * Get all permanently failed tasks
   * These tasks have exceeded MAX_RETRIES and will not be automatically retried
   */
  async getPermanentlyFailedTasks(): Promise<PersistedTask[]> {
    if (!this.db) return [];

    const all = await this.db.getAll('tasks');
    return all.filter((t) => t.status === 'permanently_failed');
  }

  /**
   * Get stale failed tasks (failed for longer than STALE_THRESHOLD_MS)
   * These are tasks that failed and haven't been retried or resolved for over 1 hour
   */
  async getStaleFailedTasks(): Promise<PersistedTask[]> {
    if (!this.db) return [];

    const now = Date.now();
    const all = await this.db.getAll('tasks');

    return all.filter((t) => {
      // Include permanently failed or error tasks that are stale
      const isFailedStatus =
        t.status === 'permanently_failed' || t.status === 'error';
      const isStale =
        t.lastAttemptAt > 0 && now - t.lastAttemptAt > STALE_THRESHOLD_MS;
      return isFailedStatus && isStale;
    });
  }

  /**
   * Retry a permanently failed task (resets retry count)
   * @param taskId - ID of the task to retry
   * @param file - The file to upload (must be re-provided as File objects aren't persisted)
   * @param readKey - The encryption key (must be re-provided as keys aren't persisted)
   */
  async retryPermanentlyFailed(
    taskId: string,
    file: File,
    readKey: Uint8Array,
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Upload queue not initialized');
    }

    const persisted = await this.db.get('tasks', taskId);
    if (!persisted) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (persisted.status !== 'permanently_failed') {
      throw new Error(`Task ${taskId} is not permanently failed`);
    }

    // Reset retry state
    persisted.retryCount = 0;
    persisted.lastAttemptAt = 0;
    persisted.status = 'queued';
    await this.db.put('tasks', persisted);

    // Create in-memory task and queue it
    const task: UploadTask = {
      id: taskId,
      file,
      albumId: persisted.albumId,
      epochId: persisted.epochId,
      readKey,
      status: 'queued',
      currentAction: 'pending',
      progress: persisted.completedShards.length / persisted.totalChunks,
      completedShards: persisted.completedShards,
      retryCount: 0,
      lastAttemptAt: 0,
      thumbnailBase64: persisted.thumbnailBase64,
      thumbWidth: persisted.thumbWidth,
      thumbHeight: persisted.thumbHeight,
      originalWidth: persisted.originalWidth,
      originalHeight: persisted.originalHeight,
      thumbhash: persisted.thumbhash,
    };

    this.queue.push(task);
    void this.processQueue();
  }

  /**
   * Clear all permanently failed tasks from the database
   */
  async clearPermanentlyFailedTasks(): Promise<number> {
    if (!this.db) return 0;

    const failed = await this.getPermanentlyFailedTasks();
    for (const task of failed) {
      await this.db.delete('tasks', task.id);
    }
    return failed.length;
  }

  /**
   * Upload data via Tus resumable protocol
   * @param albumId - Album to upload to
   * @param data - Encrypted shard data
   * @param sha256 - SHA256 hash of the encrypted data for verification
   * @param shardIndex - Index of this shard in the file
   * @returns Shard ID from server
   */
  private async tusUpload(
    albumId: string,
    data: Uint8Array,
    sha256: string,
    shardIndex: number,
  ): Promise<string> {
    log.info(
      `TUS upload starting: albumId=${albumId}, shardIndex=${shardIndex}, size=${data.byteLength} bytes`,
    );
    return new Promise((resolve, reject) => {
      // Create a new ArrayBuffer to satisfy TypeScript's BlobPart type
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);

      const upload = new tus.Upload(new Blob([buffer]), {
        endpoint: TUS_ENDPOINT,
        retryDelays: [0, 1000, 3000, 5000],
        chunkSize: data.length, // Single chunk since shards are max 6MB
        metadata: {
          albumId,
          shardIndex: String(shardIndex),
          sha256,
        },
        // Send credentials (cookies) with requests for authentication
        // In tus-js-client v2+, withCredentials is set via onBeforeRequest
        onBeforeRequest: (req) => {
          const xhr = req.getUnderlyingObject() as XMLHttpRequest;
          xhr.withCredentials = true;
          log.info(`TUS onBeforeRequest: setting withCredentials=true`);
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
          log.info(
            `TUS progress: ${bytesUploaded}/${bytesTotal} (${percentage}%)`,
          );
        },
        onError: (error) => {
          log.error(
            `TUS upload failed: albumId=${albumId}, shardIndex=${shardIndex}, error=${error.message}`,
          );
          reject(new Error(`Upload failed: ${error.message}`));
        },
        onSuccess: () => {
          // Extract shard ID from the upload URL
          const url = upload.url;
          if (!url) {
            reject(new Error('No upload URL returned'));
            return;
          }
          // URL format: /api/files/{shardId}
          const shardId = url.substring(url.lastIndexOf('/') + 1);
          log.info(
            `TUS upload success: albumId=${albumId}, shardIndex=${shardIndex}, shardId=${shardId}`,
          );
          resolve(shardId);
        },
      });

      // Start the upload
      log.info(`TUS upload.start() called`);
      upload.start();
    });
  }
}

/** Global upload queue instance */
export const uploadQueue = new UploadQueue();
