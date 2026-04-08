import { openDB, type IDBPDatabase } from 'idb';
import type { UploadQueueDB, PersistedTask } from './types';

export class UploadPersistence {
  private db: IDBPDatabase<UploadQueueDB> | null = null;

  get isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Initialize IndexedDB for upload persistence (call once on app start)
   */
  async init(): Promise<void> {
    this.db = await openDB<UploadQueueDB>('mosaic-upload-queue', 1, {
      upgrade(db) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      },
    });
  }

  /**
   * Save a new persisted task
   */
  async saveTask(task: PersistedTask): Promise<void> {
    if (!this.db) return;
    await this.db.put('tasks', task);
  }

  /**
   * Get a persisted task by ID
   */
  async getTask(id: string): Promise<PersistedTask | undefined> {
    if (!this.db) return undefined;
    return this.db.get('tasks', id);
  }

  /**
   * Delete a persisted task
   */
  async deleteTask(id: string): Promise<void> {
    if (!this.db) return;
    await this.db.delete('tasks', id);
  }

  /**
   * Update specific fields of a persisted task
   */
  async updateTask(
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
   * Get all persisted tasks
   */
  async getAllTasks(): Promise<PersistedTask[]> {
    if (!this.db) return [];
    return this.db.getAll('tasks');
  }

  /**
   * Get all pending/in-progress tasks (excludes complete and permanently failed)
   */
  async getPendingTasks(): Promise<PersistedTask[]> {
    const all = await this.getAllTasks();
    return all.filter(
      (t) => t.status !== 'complete' && t.status !== 'permanently_failed',
    );
  }

  /**
   * Get all failed tasks (both temporary errors and permanently failed)
   */
  async getFailedTasks(): Promise<PersistedTask[]> {
    const all = await this.getAllTasks();
    return all.filter(
      (t) => t.status === 'error' || t.status === 'permanently_failed',
    );
  }

  /**
   * Get all permanently failed tasks
   * These tasks have exceeded MAX_RETRIES and will not be automatically retried
   */
  async getPermanentlyFailedTasks(): Promise<PersistedTask[]> {
    const all = await this.getAllTasks();
    return all.filter((t) => t.status === 'permanently_failed');
  }

  /**
   * Get stale failed tasks (failed for longer than staleThresholdMs)
   * These are tasks that failed and haven't been retried or resolved for over 1 hour
   */
  async getStaleFailedTasks(staleThresholdMs: number): Promise<PersistedTask[]> {
    const now = Date.now();
    const all = await this.getAllTasks();

    return all.filter((t) => {
      const isFailedStatus =
        t.status === 'permanently_failed' || t.status === 'error';
      const isStale =
        t.lastAttemptAt > 0 && now - t.lastAttemptAt > staleThresholdMs;
      return isFailedStatus && isStale;
    });
  }

  /**
   * Clear all permanently failed tasks from the database
   * @returns Number of tasks cleared
   */
  async clearPermanentlyFailedTasks(): Promise<number> {
    const failed = await this.getPermanentlyFailedTasks();
    for (const task of failed) {
      await this.deleteTask(task.id);
    }
    return failed.length;
  }
}
