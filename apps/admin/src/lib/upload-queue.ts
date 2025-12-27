import { openDB, type IDBPDatabase } from 'idb';
import { getCryptoClient } from './crypto-client';

/** Chunk size for splitting files (6MB) */
const CHUNK_SIZE = 6 * 1024 * 1024;

/** Upload task status */
export type UploadStatus = 'queued' | 'uploading' | 'complete' | 'error';

/** In-memory upload task */
export interface UploadTask {
  id: string;
  file: File;
  albumId: string;
  epochId: number;
  readKey: Uint8Array;
  status: UploadStatus;
  progress: number;
  completedShards: Array<{ index: number; shardId: string }>;
  error?: string;
}

/** Persisted task state (for resume after reload) */
interface PersistedTask {
  id: string;
  albumId: string;
  fileName: string;
  fileSize: number;
  epochId: number;
  totalChunks: number;
  completedShards: Array<{ index: number; shardId: string }>;
  status: string;
}

/** IndexedDB schema */
interface UploadQueueDB {
  tasks: {
    key: string;
    value: PersistedTask;
  };
}

type ProgressCallback = (task: UploadTask) => void;
type CompleteCallback = (task: UploadTask, shardIds: string[]) => void;
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
    readKey: Uint8Array
  ): Promise<string> {
    if (!this.db) {
      throw new Error('Upload queue not initialized');
    }

    const taskId = crypto.randomUUID();
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
      progress: 0,
      completedShards: [],
    };

    this.queue.push(task);
    void this.processQueue();

    return taskId;
  }

  /**
   * Get all pending/in-progress tasks
   */
  async getPendingTasks(): Promise<PersistedTask[]> {
    if (!this.db) return [];
    
    const all = await this.db.getAll('tasks');
    return all.filter((t) => t.status !== 'complete');
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
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const task = this.queue.shift();
      if (!task) break;
      
      this.activeCount++;
      this.processTask(task)
        .catch((err) => {
          console.error('Upload task failed:', err);
        })
        .finally(() => {
          this.activeCount--;
          void this.processQueue();
        });
    }

    this.processing = false;
  }

  private async processTask(task: UploadTask): Promise<void> {
    const crypto = await getCryptoClient();

    try {
      task.status = 'uploading';
      await this.updatePersistedTask(task.id, { status: 'uploading' });

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
        const encrypted = await crypto.encryptShard(
          new Uint8Array(chunk),
          task.readKey,
          task.epochId,
          i
        );

        // Upload via Tus protocol (mock for now)
        const shardId = await this.tusUpload(task.albumId, encrypted.ciphertext);
        shardIds[i] = shardId;

        // Persist progress for resume
        task.completedShards.push({ index: i, shardId });
        await this.updatePersistedTask(task.id, {
          completedShards: task.completedShards,
        });

        // Update progress
        task.progress = (i + 1) / totalChunks;
        this.onProgress?.(task);
      }

      // Mark complete
      task.status = 'complete';
      await this.updatePersistedTask(task.id, { status: 'complete' });
      this.onComplete?.(task, shardIds);

    } catch (error) {
      task.status = 'error';
      task.error = error instanceof Error ? error.message : 'Unknown error';
      await this.updatePersistedTask(task.id, { status: 'error' });
      this.onError?.(task, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async updatePersistedTask(
    id: string,
    updates: Partial<PersistedTask>
  ): Promise<void> {
    if (!this.db) return;

    const task = await this.db.get('tasks', id);
    if (task) {
      Object.assign(task, updates);
      await this.db.put('tasks', task);
    }
  }

  /**
   * Upload data via Tus protocol
   * TODO: Replace with real tus-js-client integration
   */
  private async tusUpload(_albumId: string, _data: Uint8Array): Promise<string> {
    // Mock implementation - simulates network delay
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    
    // Return a random shard ID
    // Real implementation will return the shard ID from the server
    return crypto.randomUUID();
  }
}

/** Global upload queue instance */
export const uploadQueue = new UploadQueue();
