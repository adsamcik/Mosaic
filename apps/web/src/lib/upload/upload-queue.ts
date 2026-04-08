import { getCryptoClient } from '../crypto-client';
import { createLogger } from '../logger';
import { getMimeType, isSupportedVideoType } from '../mime-type-detection';
import { isSupportedImageType } from '../thumbnail-generator';
import { UploadPersistence } from './upload-persistence';
import { tusUpload as tusUploadFn } from './tus-upload';
import { processTieredUpload } from './tiered-upload-handler';
import { processVideoUpload } from './video-upload-handler';
import { processLegacyUpload } from './legacy-upload-handler';
import type {
  UploadTask,
  PersistedTask,
  ProgressCallback,
  CompleteCallback,
  ErrorCallback,
  UploadHandlerContext,
} from './types';
import {
  CHUNK_SIZE,
  MAX_RETRIES,
  STALE_THRESHOLD_MS,
  getRetryDelay,
} from './types';

const log = createLogger('UploadQueue');

/**
 * Upload Queue Manager
 * Handles chunked, encrypted, resumable file uploads
 */
class UploadQueue {
  private queue: UploadTask[] = [];
  private processing = false;
  private maxConcurrent = 2;
  private activeCount = 0;
  private persistence = new UploadPersistence();

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
    await this.persistence.init();
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
    if (!this.persistence.isInitialized) {
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
    await this.persistence.saveTask(persisted);

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
    return this.persistence.getPendingTasks();
  }

  /**
   * Get all failed tasks (both temporary errors and permanently failed)
   */
  async getFailedTasks(): Promise<PersistedTask[]> {
    return this.persistence.getFailedTasks();
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
    await this.persistence.deleteTask(taskId);
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

  /** Build the handler context that provides shared operations to handlers */
  private getHandlerContext(): UploadHandlerContext {
    return {
      tusUpload: (albumId, data, sha256, shardIndex) =>
        this.tusUpload(albumId, data, sha256, shardIndex),
      updatePersistedTask: (id, updates) =>
        this.persistence.updateTask(id, updates),
      onProgress: this.onProgress,
      onComplete: this.onComplete,
    };
  }

  /**
   * Upload data via Tus resumable protocol (delegates to standalone function).
   * Kept as a class method so tests can spy on it.
   */
  private tusUpload(
    albumId: string,
    data: Uint8Array,
    sha256: string,
    shardIndex: number,
  ): Promise<string> {
    return tusUploadFn(albumId, data, sha256, shardIndex);
  }

  private async processTask(task: UploadTask): Promise<void> {
    log.info(
      `Processing task ${task.id}: ${task.file.name} (${task.file.type}, ${task.file.size} bytes)`,
    );
    const cryptoClient = await getCryptoClient();
    const ctx = this.getHandlerContext();

    try {
      task.status = 'uploading';
      task.currentAction = 'pending';
      await this.persistence.updateTask(task.id, { status: 'uploading' });

      // Detect actual MIME type from file magic bytes
      // This is more reliable than file.type for formats like HEIC
      const detectedMimeType = await getMimeType(task.file);
      task.detectedMimeType = detectedMimeType;
      log.info(
        `Detected MIME type: ${detectedMimeType} (browser reported: ${task.file.type})`,
      );

      // Route to the appropriate upload path based on detected file type
      if (isSupportedVideoType(detectedMimeType)) {
        // Video upload: extract frame thumbnail + chunked original
        log.info(`Using video upload for: ${task.file.name}`);
        await processVideoUpload(task, ctx);
      } else if (isSupportedImageType(detectedMimeType)) {
        // Tiered image upload: thumb, preview, and original shards
        log.info(`Using tiered upload for image: ${task.file.name}`);
        await processTieredUpload(task, ctx);
      } else {
        // Legacy flow for unsupported formats - chunked original only
        log.info(`Using legacy upload for non-image: ${task.file.name}`);
        await processLegacyUpload(task, cryptoClient, ctx);
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

        await this.persistence.updateTask(task.id, {
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
        await this.persistence.updateTask(task.id, {
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
   * Get all permanently failed tasks
   * These tasks have exceeded MAX_RETRIES and will not be automatically retried
   */
  async getPermanentlyFailedTasks(): Promise<PersistedTask[]> {
    return this.persistence.getPermanentlyFailedTasks();
  }

  /**
   * Get stale failed tasks (failed for longer than STALE_THRESHOLD_MS)
   * These are tasks that failed and haven't been retried or resolved for over 1 hour
   */
  async getStaleFailedTasks(): Promise<PersistedTask[]> {
    return this.persistence.getStaleFailedTasks(STALE_THRESHOLD_MS);
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
    if (!this.persistence.isInitialized) {
      throw new Error('Upload queue not initialized');
    }

    const persisted = await this.persistence.getTask(taskId);
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
    await this.persistence.saveTask(persisted);

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
      ...(persisted.thumbnailBase64 !== undefined ? { thumbnailBase64: persisted.thumbnailBase64 } : {}),
      ...(persisted.thumbWidth !== undefined ? { thumbWidth: persisted.thumbWidth } : {}),
      ...(persisted.thumbHeight !== undefined ? { thumbHeight: persisted.thumbHeight } : {}),
      ...(persisted.originalWidth !== undefined ? { originalWidth: persisted.originalWidth } : {}),
      ...(persisted.originalHeight !== undefined ? { originalHeight: persisted.originalHeight } : {}),
      ...(persisted.thumbhash !== undefined ? { thumbhash: persisted.thumbhash } : {}),
      ...(persisted.videoMetadata ? { videoMetadata: persisted.videoMetadata } : {}),
    };

    this.queue.push(task);
    void this.processQueue();
  }

  /**
   * Clear all permanently failed tasks from the database
   */
  async clearPermanentlyFailedTasks(): Promise<number> {
    return this.persistence.clearPermanentlyFailedTasks();
  }
}

/** Global upload queue instance */
export const uploadQueue = new UploadQueue();
