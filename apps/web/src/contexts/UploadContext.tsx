import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getCurrentOrFetchEpochKey } from '../lib/epoch-key-service';
import { type EpochKeyBundle, getEpochKey } from '../lib/epoch-key-store';
import { FeatureFlagsManager } from '../lib/feature-flags';
import { createLogger } from '../lib/logger';
import { createManifestForUpload } from '../lib/manifest-service';
import { RustUploadAdapter } from '../lib/rust-core/upload-adapter';
import {
  type WasmUploadAdapterBindings,
  WasmUploadAdapterPort,
} from '../lib/rust-core/wasm-upload-adapter-port';
import { syncEngine } from '../lib/sync-engine';
import { UploadError, UploadErrorCode } from '../lib/upload-errors';
import {
  createUuidV7,
  uploadQueue,
  type UploadTask,
} from '../lib/upload-queue';
import { initUploadStoreBridge } from '../lib/upload-store-bridge';

// Re-export for consumers
export { UploadError, UploadErrorCode } from '../lib/upload-errors';

const log = createLogger('UploadContext');
const RUST_UPLOAD_MAX_RETRY_COUNT = 3;
let rustWasmBindings: WasmUploadAdapterBindings | null = null;

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
  /** Clear legacy pre-migration upload queue records */
  resetLegacyUploadQueue: () => Promise<number>;
}

const UploadContext = createContext<UploadContextValue | null>(null);

interface UploadProviderProps {
  children: ReactNode;
}

function createRustUploadAdapter(): RustUploadAdapter {
  return new RustUploadAdapter(new WasmUploadAdapterPort({
    init: () => loadRustWasmBindings().then(() => undefined),
    initUploadJob: (...args) => getRustWasmBindings().initUploadJob(...args),
    advanceUploadJob: (...args) => getRustWasmBindings().advanceUploadJob(...args),
    clientCoreStateMachineSnapshot: () => getRustWasmBindings().clientCoreStateMachineSnapshot(),
  }));
}

async function loadRustWasmBindings(): Promise<WasmUploadAdapterBindings> {
  if (rustWasmBindings === null) {
    const module = await import('../generated/mosaic-wasm/mosaic_wasm.js');
    const bindings: WasmUploadAdapterBindings = {
      init: () => module.default().then(() => undefined),
      initUploadJob: module.initUploadJob,
      advanceUploadJob: module.advanceUploadJob,
      clientCoreStateMachineSnapshot: module.clientCoreStateMachineSnapshot,
    };
    await bindings.init();
    rustWasmBindings = bindings;
  }
  return rustWasmBindings;
}

function getRustWasmBindings(): WasmUploadAdapterBindings {
  if (rustWasmBindings === null) {
    throw new Error('Rust WASM upload bindings are not initialized');
  }
  return rustWasmBindings;
}

/**
 * Provider component for upload functionality.
 * Wraps components that need access to upload state and actions.
 */
export function UploadProvider({ children }: UploadProviderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const [, setActiveTasks] = useState<UploadTask[]>([]);
  const getRustUploadAdapter = useMemo(() => {
    let adapter: RustUploadAdapter | null = null;
    return (): RustUploadAdapter => {
      adapter ??= createRustUploadAdapter();
      return adapter;
    };
  }, []);

  // Initialize upload-store bridge AND set up upload queue callbacks together
  // This ensures proper cleanup/re-initialization on StrictMode remounts
  useEffect(() => {
    // 1. Initialize the bridge first (sets up PhotoStore integration)
    const bridgeCleanup = initUploadStoreBridge();

    // 2. Capture the bridge handlers that were just set up
    const bridgeOnProgress = uploadQueue.onProgress;
    const bridgeOnComplete = uploadQueue.onComplete;
    const bridgeOnError = uploadQueue.onError;

    // 3. Set up progress callback
    uploadQueue.onProgress = (task) => {
      // Call bridge handler first (adds to PhotoStore)
      bridgeOnProgress?.(task);
      // Then update local UI state
      setProgress(Math.round(task.progress * 100));
      setActiveTasks((prev) => {
        const index = prev.findIndex((t) => t.id === task.id);
        if (index === -1) return [...prev, task];
        const next = [...prev];
        next[index] = task;
        return next;
      });
    };

    // 4. Set up complete callback
    uploadQueue.onComplete = async (task, shardIds, tieredShards) => {
      // Call bridge handler first (transitions to syncing in PhotoStore)
      await bridgeOnComplete?.(task, shardIds, tieredShards);
      // Remove from active tasks
      setActiveTasks((prev) => prev.filter((t) => t.id !== task.id));

      try {
        // Look up the full epoch key from the store using task's albumId and epochId
        // The epoch key was cached when upload() fetched it via getCurrentOrFetchEpochKey
        const epochKey = getEpochKey(task.albumId, task.epochId);
        if (!epochKey) {
          throw new Error(
            `Epoch key not found for album ${task.albumId}, epoch ${task.epochId}`,
          );
        }

        await createManifestForUpload(task, shardIds, epochKey, tieredShards);

        // Sync to pull the newly created manifest into local DB
        log.info(`Upload complete, syncing album ${task.albumId}`);
        try {
          await syncEngine.sync(task.albumId, epochKey.epochHandleId);
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
            manifestErr instanceof Error ? manifestErr : undefined,
          ),
        );
        setIsUploading(false);
      }
    };

    // 5. Set up error callback
    uploadQueue.onError = (task, uploadErr) => {
      // Call bridge handler first (marks as failed in PhotoStore)
      bridgeOnError?.(task, uploadErr);

      // Remove from active tasks
      setActiveTasks((prev) => prev.filter((t) => t.id !== task.id));

      log.error('Upload failed:', uploadErr);
      setError(
        new UploadError(
          uploadErr.message,
          UploadErrorCode.UPLOAD_FAILED,
          uploadErr,
        ),
      );
      setIsUploading(false);
    };

    let cancelled = false;
    void uploadQueue.init().catch((err: unknown) => {
      if (cancelled) return;
      log.warn('Upload queue initialization failed:', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Cleanup: bridge cleanup will restore original callbacks
    return () => {
      cancelled = true;
      bridgeCleanup();
    };
  }, []);

  // Warn user before leaving page during upload
  useEffect(() => {
    if (!isUploading) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Standard way to trigger browser's confirmation dialog
      e.preventDefault();
      // For older browsers, return a string (modern browsers show generic message)
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isUploading]);

  const upload = useCallback(async (file: File, albumId: string) => {
    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Initialize upload queue if needed
      await uploadQueue.init();

      if (FeatureFlagsManager.load().rustCoreUpload) {
        // During the staged rollout both paths intentionally coexist: Rust core
        // owns the upload state-machine preflight while the legacy queue still
        // executes media preparation, encryption, Tus upload, and manifest work.
        try {
          const adapter = getRustUploadAdapter();
          const rustJobId = createUuidV7();
          await adapter.start({
            jobId: rustJobId,
            albumId,
            assetId: createUuidV7(),
            idempotencyKey: createUuidV7(),
            maxRetryCount: RUST_UPLOAD_MAX_RETRY_COUNT,
          });
          await adapter.submit({
            kind: 'StartRequested',
            effectId: createUuidV7(),
          });
        } catch (rustErr) {
          log.warn('Rust upload preflight failed; falling back to legacy upload executor:', {
            error: rustErr instanceof Error ? rustErr.message : String(rustErr),
          });
        }
      }

      // Get the current epoch key for this album
      // This caches the key in epoch-key-store for use in onComplete callback
      let epochKey: EpochKeyBundle;
      try {
        epochKey = await getCurrentOrFetchEpochKey(albumId);
      } catch (err) {
        const uploadError = new UploadError(
          `Failed to get epoch key for album: ${err instanceof Error ? err.message : String(err)}`,
          UploadErrorCode.EPOCH_KEY_FAILED,
          err instanceof Error ? err : undefined,
        );
        setError(uploadError);
        setIsUploading(false);
        throw uploadError;
      }

      // Add file to queue with real epoch key
      log.info(
        `Adding file to upload queue: ${file.name}, albumId=${albumId}, epochId=${epochKey.epochId}`,
      );
      await uploadQueue.add(
        file,
        albumId,
        epochKey.epochId,
        epochKey.epochHandleId,
      );
      log.info(`File added to upload queue: ${file.name}`);
    } catch (err) {
      // Only handle errors not already handled above
      if (!(err instanceof UploadError)) {
        log.error('Upload error:', err);
        const uploadError = new UploadError(
          err instanceof Error ? err.message : String(err),
          UploadErrorCode.UPLOAD_FAILED,
          err instanceof Error ? err : undefined,
        );
        setError(uploadError);
        setIsUploading(false);
      }
    }
  }, [getRustUploadAdapter]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const resetLegacyUploadQueue = useCallback(async (): Promise<number> => {
    await uploadQueue.init();
    return uploadQueue.resetLegacyUploadQueue();
  }, []);

  // Memoize context value to prevent unnecessary re-renders of consumers
  const contextValue = useMemo<UploadContextValue>(
    () => ({
      isUploading,
      progress,
      error,
      upload,
      clearError,
      resetLegacyUploadQueue,
    }),
    [isUploading, progress, error, upload, clearError, resetLegacyUploadQueue],
  );

  return (
    <UploadContext.Provider value={contextValue}>
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
