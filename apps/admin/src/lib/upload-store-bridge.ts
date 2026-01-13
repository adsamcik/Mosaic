/**
 * Upload Store Bridge
 * 
 * Connects upload lifecycle events from the UploadQueue to the PhotoStore.
 * This bridge ensures photos appear immediately in the gallery when upload starts,
 * with real-time progress updates, without waiting for sync-complete.
 * 
 * Lifecycle:
 * 1. Upload starts → addPending (photo appears with local blob URL)
 * 2. Progress updates → updateProgress (progress bar updates)
 * 3. Upload complete → transitionToSyncing (await sync confirmation)
 * 4. Sync complete → handled by SyncCoordinator (promotes to stable)
 * 5. Upload error → markUploadFailed or removePending
 * 
 * The bridge is initialized once by UploadProvider and cleaned up on unmount.
 */

import { usePhotoStore } from '../stores/photo-store';
import type { TieredShardIds } from '../workers/types';
import { createLogger } from './logger';
import { syncCoordinator } from './sync-coordinator';
import { uploadQueue, type UploadTask } from './upload-queue';

const log = createLogger('upload-store-bridge');

/** Track which tasks have been registered to prevent duplicates */
const registeredTasks = new Set<string>();

/** Store cleanup function for bridge disposal */
let cleanupFn: (() => void) | null = null;

/** Track if bridge is initialized */
let initialized = false;

/**
 * Map upload queue action to store action
 */
function mapAction(action: string): 'waiting' | 'encrypting' | 'uploading' | 'finalizing' {
  switch (action) {
    case 'encrypting': return 'encrypting';
    case 'uploading': return 'uploading';
    case 'finalizing': return 'finalizing';
    default: return 'waiting';
  }
}

/**
 * Handle upload progress event.
 * Creates pending item on first progress, updates progress thereafter.
 */
function handleProgress(task: UploadTask): void {
  const store = usePhotoStore.getState();
  
  // Ensure album is initialized
  store.initAlbum(task.albumId);
  
  // Check if this task is already registered
  if (!registeredTasks.has(task.id)) {
    // First progress event for this task - create pending item
    registeredTasks.add(task.id);
    
    // Create local blob URL for immediate thumbnail display
    const localBlobUrl = URL.createObjectURL(task.file);
    
    store.addPending(task.albumId, task.id, localBlobUrl);
    
    log.debug(`Added pending photo: albumId=${task.albumId}, assetId=${task.id}`);
  }
  
  // Update progress (0-1 scale in task, store expects 0-100) and action
  const progressPercent = Math.round(task.progress * 100);
  const action = mapAction(task.currentAction);
  store.updateProgress(task.albumId, task.id, progressPercent, action);
}

/**
 * Handle upload complete event.
 * Transitions pending item to syncing state and registers with SyncCoordinator.
 * Does NOT remove the item - SyncCoordinator handles promotion to stable.
 */
function handleComplete(task: UploadTask, _shardIds: string[]): void {
  const store = usePhotoStore.getState();
  
  // Ensure we have a registered task
  if (!registeredTasks.has(task.id)) {
    log.warn(`Complete event for unregistered task: ${task.id}`);
    return;
  }
  
  // Transition to syncing state - awaiting sync confirmation
  store.transitionToSyncing(task.albumId, task.id);
  
  // Register with SyncCoordinator to track pending sync confirmation
  syncCoordinator.registerPendingSync(task.albumId, task.id);
  
  log.debug(
    `Upload complete, transitioned to syncing: albumId=${task.albumId}, assetId=${task.id}`
  );
  
  // Note: We do NOT remove from registeredTasks here.
  // The task stays registered until sync confirms or times out.
  // SyncCoordinator will handle promotion to stable.
}

/**
 * Handle upload error event.
 * Marks the item as failed or removes it depending on error severity.
 */
function handleError(task: UploadTask, error: Error): void {
  const store = usePhotoStore.getState();
  
  // Check if this is a permanent failure (max retries exceeded)
  const isPermanentFailure = task.status === 'permanently_failed';
  
  if (!registeredTasks.has(task.id)) {
    // Task was never added to store (error before first progress)
    log.debug(`Error for unregistered task: ${task.id}, error: ${error.message}`);
    return;
  }
  
  if (isPermanentFailure) {
    // Permanent failure - mark as failed but keep visible for user action
    store.markUploadFailed(task.albumId, task.id, error.message);
    
    log.warn(
      `Upload permanently failed: albumId=${task.albumId}, assetId=${task.id}, error=${error.message}`
    );
  } else {
    // Temporary error with pending retry - just mark as failed
    // The task will be re-queued automatically by uploadQueue
    store.markUploadFailed(task.albumId, task.id, error.message);
    
    log.debug(
      `Upload error (will retry): albumId=${task.albumId}, assetId=${task.id}, ` +
      `attempt=${task.retryCount}, error=${error.message}`
    );
  }
  
  // Cancel any pending sync registration since upload failed
  syncCoordinator.cancelPendingSync(task.albumId, task.id);
}

/**
 * Remove a pending upload from the store.
 * Call this when user cancels an upload.
 */
export function cancelUploadInStore(albumId: string, assetId: string): void {
  const store = usePhotoStore.getState();
  
  // Remove from store (this also revokes blob URL)
  store.removePending(albumId, assetId);
  
  // Remove from registered tasks
  registeredTasks.delete(assetId);
  
  // Cancel pending sync registration
  syncCoordinator.cancelPendingSync(albumId, assetId);
  
  log.debug(`Cancelled upload: albumId=${albumId}, assetId=${assetId}`);
}

/**
 * Retry a failed upload.
 * Call this when user wants to retry a failed upload.
 * Resets the error state so the item shows as pending again.
 */
export function retryUploadInStore(albumId: string, assetId: string): void {
  const store = usePhotoStore.getState();
  const photo = store.getPhoto(albumId, assetId);
  
  if (!photo) {
    log.warn(`Cannot retry - photo not found: albumId=${albumId}, assetId=${assetId}`);
    return;
  }
  
  // Reset progress and clear error
  store.updateProgress(albumId, assetId, 0);
  
  // Note: The actual retry is handled by uploadQueue.retryPermanentlyFailed()
  // This just resets the visual state
  
  log.debug(`Retry requested: albumId=${albumId}, assetId=${assetId}`);
}

/**
 * Dismiss a failed upload.
 * Removes the failed item from the store entirely.
 */
export function dismissFailedUpload(albumId: string, assetId: string): void {
  const store = usePhotoStore.getState();
  
  // Remove from store
  store.removePending(albumId, assetId);
  
  // Remove from registered tasks
  registeredTasks.delete(assetId);
  
  log.debug(`Dismissed failed upload: albumId=${albumId}, assetId=${assetId}`);
}

/**
 * Initialize the upload-store bridge.
 * Sets up listeners on uploadQueue and connects events to PhotoStore.
 * Should be called once when UploadProvider mounts.
 * 
 * @returns Cleanup function to call when UploadProvider unmounts
 */
export function initUploadStoreBridge(): () => void {
  if (initialized) {
    log.warn('Upload store bridge already initialized');
    return cleanupFn ?? (() => {});
  }
  
  // Store previous callbacks to chain them
  const previousOnProgress = uploadQueue.onProgress;
  const previousOnComplete = uploadQueue.onComplete;
  const previousOnError = uploadQueue.onError;
  
  // Set up progress handler (chains with existing)
  uploadQueue.onProgress = (task: UploadTask) => {
    handleProgress(task);
    previousOnProgress?.(task);
  };
  
  // Set up complete handler (chains with existing)
  uploadQueue.onComplete = (task: UploadTask, shardIds: string[], tieredShards?: TieredShardIds) => {
    handleComplete(task, shardIds);
    // Note: previousOnComplete may be async (creates manifest)
    // We call it but don't await - let it run in parallel
    // Forward all parameters including tieredShards
    void previousOnComplete?.(task, shardIds, tieredShards);
  };
  
  // Set up error handler (chains with existing)
  uploadQueue.onError = (task: UploadTask, error: Error) => {
    handleError(task, error);
    previousOnError?.(task, error);
  };
  
  initialized = true;
  
  // Create cleanup function
  cleanupFn = () => {
    // Restore previous callbacks (use delete to remove if they were undefined)
    if (previousOnProgress) {
      uploadQueue.onProgress = previousOnProgress;
    } else {
      delete uploadQueue.onProgress;
    }
    
    if (previousOnComplete) {
      uploadQueue.onComplete = previousOnComplete;
    } else {
      delete uploadQueue.onComplete;
    }
    
    if (previousOnError) {
      uploadQueue.onError = previousOnError;
    } else {
      delete uploadQueue.onError;
    }
    
    // Clear registered tasks (but don't revoke URLs - store handles that)
    registeredTasks.clear();
    
    initialized = false;
    cleanupFn = null;
    
    log.info('Upload store bridge disposed');
  };
  
  log.info('Upload store bridge initialized');
  
  return cleanupFn;
}

/**
 * Check if bridge is initialized (for testing/debugging)
 */
export function isUploadStoreBridgeInitialized(): boolean {
  return initialized;
}

/**
 * Get count of registered tasks (for testing/debugging)
 */
export function getRegisteredTaskCount(): number {
  return registeredTasks.size;
}
