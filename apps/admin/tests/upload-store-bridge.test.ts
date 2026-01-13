import { enableMapSet } from 'immer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadQueue, type UploadTask } from '../src/lib/upload-queue';
import {
    cancelUploadInStore,
    dismissFailedUpload,
    getRegisteredTaskCount,
    initUploadStoreBridge,
    isUploadStoreBridgeInitialized,
    retryUploadInStore,
} from '../src/lib/upload-store-bridge';
import { usePhotoStore } from '../src/stores/photo-store';

// Enable Immer's MapSet plugin (required for photo-store which uses Map)
enableMapSet();

// Mock the sync coordinator
vi.mock('../src/lib/sync-coordinator', () => ({
  syncCoordinator: {
    registerPendingSync: vi.fn(),
    cancelPendingSync: vi.fn(),
  },
}));

// Mock the logger
vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Create mock task factory
function createMockTask(overrides: Partial<UploadTask> = {}): UploadTask {
  const mockFile = new File(['test content'], 'test.jpg', { type: 'image/jpeg' });
  return {
    id: 'task-123',
    file: mockFile,
    albumId: 'album-456',
    epochId: 1,
    readKey: new Uint8Array(32),
    status: 'uploading',
    currentAction: 'uploading',
    progress: 0,
    completedShards: [],
    retryCount: 0,
    lastAttemptAt: 0,
    ...overrides,
  };
}

describe('Upload Store Bridge', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    // Reset the photo store before each test
    usePhotoStore.setState({
      albums: new Map(),
      activeAlbumId: null,
    });
    
    // Clear any previous upload queue callbacks
    delete uploadQueue.onProgress;
    delete uploadQueue.onComplete;
    delete uploadQueue.onError;
  });

  afterEach(() => {
    // Clean up bridge if initialized
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    vi.clearAllMocks();
  });

  describe('initUploadStoreBridge', () => {
    it('initializes the bridge and returns cleanup function', () => {
      expect(isUploadStoreBridgeInitialized()).toBe(false);
      
      cleanup = initUploadStoreBridge();
      
      expect(isUploadStoreBridgeInitialized()).toBe(true);
      expect(typeof cleanup).toBe('function');
    });

    it('sets up upload queue callbacks', () => {
      cleanup = initUploadStoreBridge();
      
      expect(uploadQueue.onProgress).toBeDefined();
      expect(uploadQueue.onComplete).toBeDefined();
      expect(uploadQueue.onError).toBeDefined();
    });

    it('returns existing cleanup function if already initialized', () => {
      cleanup = initUploadStoreBridge();
      const secondCleanup = initUploadStoreBridge();
      
      expect(secondCleanup).toBe(cleanup);
    });

    it('cleans up properly when cleanup is called', () => {
      cleanup = initUploadStoreBridge();
      cleanup();
      cleanup = null;
      
      expect(isUploadStoreBridgeInitialized()).toBe(false);
      expect(getRegisteredTaskCount()).toBe(0);
    });
  });

  describe('progress handling', () => {
    it('creates pending photo on first progress event', () => {
      cleanup = initUploadStoreBridge();
      const task = createMockTask({ progress: 0.1 });
      
      // Simulate progress callback
      uploadQueue.onProgress?.(task);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo).toBeDefined();
      expect(photo?.status).toBe('pending');
      expect(photo?.localBlobUrl).toBeDefined();
    });

    it('updates progress on subsequent progress events', () => {
      cleanup = initUploadStoreBridge();
      const task = createMockTask({ progress: 0 });
      
      // First progress creates the pending item
      uploadQueue.onProgress?.(task);
      
      // Second progress updates it
      task.progress = 0.5;
      uploadQueue.onProgress?.(task);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo?.uploadProgress).toBe(50);
    });

    it('initializes album state if needed', () => {
      cleanup = initUploadStoreBridge();
      const task = createMockTask();
      
      uploadQueue.onProgress?.(task);
      
      const store = usePhotoStore.getState();
      const albumState = store.albums.get(task.albumId);
      
      expect(albumState).toBeDefined();
    });

    it('does not create duplicate pending photos', () => {
      cleanup = initUploadStoreBridge();
      const task = createMockTask();
      
      // Multiple progress events for the same task
      uploadQueue.onProgress?.(task);
      uploadQueue.onProgress?.(task);
      uploadQueue.onProgress?.(task);
      
      expect(getRegisteredTaskCount()).toBe(1);
    });
  });

  describe('complete handling', () => {
    it('transitions pending photo to syncing state', async () => {
      const { syncCoordinator } = await import('../src/lib/sync-coordinator');
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask({ progress: 1 });
      
      // First, simulate progress to create the pending item
      uploadQueue.onProgress?.(task);
      
      // Then simulate complete
      uploadQueue.onComplete?.(task, ['shard-1', 'shard-2']);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo?.status).toBe('syncing');
      expect(syncCoordinator.registerPendingSync).toHaveBeenCalledWith(task.albumId, task.id);
    });

    it('does not remove photo on complete (lets SyncCoordinator handle promotion)', async () => {
      cleanup = initUploadStoreBridge();
      const task = createMockTask({ progress: 1 });
      
      uploadQueue.onProgress?.(task);
      uploadQueue.onComplete?.(task, ['shard-1']);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      // Photo should still exist
      expect(photo).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('marks photo as failed on error', async () => {
      const { syncCoordinator } = await import('../src/lib/sync-coordinator');
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask({ retryCount: 1 });
      
      // Create pending item first
      uploadQueue.onProgress?.(task);
      
      // Simulate error
      const error = new Error('Upload failed');
      uploadQueue.onError?.(task, error);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo?.error).toBe('Upload failed');
      expect(syncCoordinator.cancelPendingSync).toHaveBeenCalledWith(task.albumId, task.id);
    });

    it('marks permanent failure when max retries exceeded', async () => {
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask({ 
        status: 'permanently_failed',
        retryCount: 3,
      });
      
      uploadQueue.onProgress?.(task);
      uploadQueue.onError?.(task, new Error('Max retries exceeded'));
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo?.error).toBe('Max retries exceeded');
    });
  });

  describe('cancelUploadInStore', () => {
    it('removes pending photo from store', async () => {
      const { syncCoordinator } = await import('../src/lib/sync-coordinator');
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask();
      uploadQueue.onProgress?.(task);
      
      cancelUploadInStore(task.albumId, task.id);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo).toBeUndefined();
      expect(syncCoordinator.cancelPendingSync).toHaveBeenCalledWith(task.albumId, task.id);
    });
  });

  describe('dismissFailedUpload', () => {
    it('removes failed photo from store', () => {
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask({ status: 'error' });
      uploadQueue.onProgress?.(task);
      uploadQueue.onError?.(task, new Error('Failed'));
      
      dismissFailedUpload(task.albumId, task.id);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo).toBeUndefined();
    });
  });

  describe('retryUploadInStore', () => {
    it('resets progress for retry', () => {
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask({ progress: 0.5 });
      uploadQueue.onProgress?.(task);
      
      retryUploadInStore(task.albumId, task.id);
      
      const store = usePhotoStore.getState();
      const photo = store.getPhoto(task.albumId, task.id);
      
      expect(photo?.uploadProgress).toBe(0);
    });
  });

  describe('callback chaining', () => {
    it('chains with existing onProgress callback', () => {
      const existingCallback = vi.fn();
      uploadQueue.onProgress = existingCallback;
      
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask();
      uploadQueue.onProgress?.(task);
      
      expect(existingCallback).toHaveBeenCalledWith(task);
    });

    it('chains with existing onComplete callback', () => {
      const existingCallback = vi.fn();
      uploadQueue.onComplete = existingCallback;
      
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask();
      uploadQueue.onProgress?.(task);
      uploadQueue.onComplete?.(task, ['shard-1']);
      
      // Callback receives (task, shardIds, tieredShards) - tieredShards is undefined here
      expect(existingCallback).toHaveBeenCalledWith(task, ['shard-1'], undefined);
    });

    it('chains with existing onError callback', () => {
      const existingCallback = vi.fn();
      uploadQueue.onError = existingCallback;
      
      cleanup = initUploadStoreBridge();
      
      const task = createMockTask();
      uploadQueue.onProgress?.(task);
      const error = new Error('Test error');
      uploadQueue.onError?.(task, error);
      
      expect(existingCallback).toHaveBeenCalledWith(task, error);
    });

    it('restores previous callbacks on cleanup', () => {
      const existingCallback = vi.fn();
      uploadQueue.onProgress = existingCallback;
      
      cleanup = initUploadStoreBridge();
      cleanup();
      cleanup = null;
      
      expect(uploadQueue.onProgress).toBe(existingCallback);
    });
  });
});
