import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { syncCoordinator } from '../lib/sync-coordinator';
import { UploadError, UploadErrorCode } from '../lib/upload-errors';
import {
  createUuidV7,
  uploadQueue,
  type UploadTask,
} from '../lib/upload';
import { initUploadStoreBridge } from '../lib/upload-store-bridge';
import { session, subscribeToSessionExpired } from '../lib/session';
import { useOptionalToast } from './ToastContext';

// Re-export for consumers
export { UploadError, UploadErrorCode } from '../lib/upload-errors';

const log = createLogger('UploadContext');
const RUST_UPLOAD_MAX_RETRY_COUNT = 3;
const UPLOAD_ACTIVE_EVENT = 'mosaic:upload-active';
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

function submitRustProgressEvents(
  task: UploadTask,
  adapter: RustUploadAdapter | undefined,
  submittedByTaskId: Map<string, Set<string>>,
): void {
  if (!adapter) return;

  const submitted = submittedByTaskId.get(task.id) ?? new Set<string>();
  submittedByTaskId.set(task.id, submitted);

  if (task.currentAction === 'encrypting' && !submitted.has('MediaPrepared')) {
    submitted.add('MediaPrepared');
    void adapter.submit({ kind: 'MediaPrepared', effectId: task.id });
    submitted.add('EpochHandleAcquired');
    void adapter.submit({ kind: 'EpochHandleAcquired', effectId: task.id });
  }

  for (const shard of task.completedShards) {
    const key = `${shard.tier ?? 3}:${shard.index}:${shard.shardId}`;
    if (submitted.has(key)) continue;
    submitted.add(key);
    submitRustShardEvents(adapter, task.id, shard);
  }
}

function submitRustShardEvents(
  adapter: RustUploadAdapter,
  effectId: string,
  shard: UploadTask['completedShards'][number],
): void {
  const event = {
    effectId,
    tier: shard.tier ?? 3,
    shardIndex: shard.index,
    shardId: shard.shardId,
    sha256: sha256BytesForRustEvent(shard.sha256),
    contentLength: BigInt(shard.contentLength ?? 0),
    envelopeVersion: shard.envelopeVersion ?? 3,
  };
  void adapter.submit({ kind: 'ShardEncrypted', ...event });
  void adapter.submit({ kind: 'ShardUploadCreated', ...event });
  void adapter.submit({ kind: 'ShardUploaded', ...event });
}

function sha256BytesForRustEvent(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/**
 * Provider component for upload functionality.
 * Wraps components that need access to upload state and actions.
 */
export function UploadProvider({ children }: UploadProviderProps) {
  const [activeUploadCount, setActiveUploadCount] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const [, setActiveTasks] = useState<UploadTask[]>([]);
  const toast = useOptionalToast();
  const addToast = toast?.addToast ?? (() => '');
  const removeToast = toast?.removeToast ?? (() => undefined);
  const rustAdaptersByTaskId = useRef(new Map<string, RustUploadAdapter>());
  const rustSubmittedTaskEvents = useRef(new Map<string, Set<string>>());
  const sessionExpiredToastId = useRef<string | null>(null);
  const isUploading = activeUploadCount > 0;
  const getRustUploadAdapter = useMemo(() => {
    let adapter: RustUploadAdapter | null = null;
    return (): RustUploadAdapter => {
      adapter ??= createRustUploadAdapter();
      return adapter;
    };
  }, []);
  const incrementActiveUploadCount = useCallback(() => {
    setActiveUploadCount((count) => count + 1);
  }, []);
  const decrementActiveUploadCount = useCallback(() => {
    setActiveUploadCount((count) => Math.max(0, count - 1));
  }, []);
  const dismissSessionExpiredToast = useCallback(() => {
    if (sessionExpiredToastId.current !== null) {
      removeToast(sessionExpiredToastId.current);
      sessionExpiredToastId.current = null;
    }
  }, [removeToast]);
  const showSessionExpiredToast = useCallback(() => {
    if (sessionExpiredToastId.current !== null) {
      return;
    }
    sessionExpiredToastId.current = addToast({
      type: 'error',
      duration: 0,
      message: 'Your session expired. Sign in again to resume your upload(s).',
      action: {
        label: 'Sign in',
        onClick: () => {
          window.history.replaceState(null, '', '/');
          document.getElementById('main-content')?.scrollIntoView();
        },
      },
    });
  }, [addToast]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(UPLOAD_ACTIVE_EVENT, {
        detail: {
          active: isUploading,
          activeUploadCount,
        },
      }),
    );
  }, [activeUploadCount, isUploading]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(
        new CustomEvent(UPLOAD_ACTIVE_EVENT, {
          detail: {
            active: false,
            activeUploadCount: 0,
          },
        }),
      );
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
      submitRustProgressEvents(
        task,
        rustAdaptersByTaskId.current.get(task.id),
        rustSubmittedTaskEvents.current,
      );
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
      try {
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

          const adapter = rustAdaptersByTaskId.current.get(task.id);
          await createManifestForUpload(task, shardIds, epochKey, tieredShards, {
            ...(adapter ? { adapter } : {}),
          });

          // Sync to pull the newly created manifest into local DB
          log.info(`Upload complete, syncing album ${task.albumId}`);
          try {
            await syncEngine.sync(task.albumId, epochKey.epochHandleId);
            log.info(`Post-upload sync complete for album ${task.albumId}`);
            // Safety-net: force-flush sync-complete processing synchronously
            // so the pending overlay clears deterministically. Without this,
            // single-photo uploads can race the 100ms SyncCoordinator
            // debounce and leave the overlay stuck (validation-photos-02).
            try {
              await syncCoordinator.flushSyncCompleteNow(task.albumId);
            } catch (flushErr) {
              log.warn('flushSyncCompleteNow failed (non-fatal):', {
                error:
                  flushErr instanceof Error
                    ? flushErr.message
                    : String(flushErr),
              });
            }
          } catch (syncErr) {
            // Non-fatal: photo was uploaded, sync will happen later
            log.warn('Post-upload sync failed (photo still uploaded):', {
              error: syncErr instanceof Error ? syncErr.message : String(syncErr),
            });
          }

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
        }
      } finally {
        rustAdaptersByTaskId.current.delete(task.id);
        rustSubmittedTaskEvents.current.delete(task.id);
        decrementActiveUploadCount();
      }
    };

    // 5. Set up error callback
    uploadQueue.onError = (task, uploadErr) => {
      try {
        // Call bridge handler first (marks as failed in PhotoStore)
        bridgeOnError?.(task, uploadErr);

        // Remove from active tasks
        setActiveTasks((prev) => prev.filter((t) => t.id !== task.id));

        log.error('Upload failed:', uploadErr);
        const adapter = rustAdaptersByTaskId.current.get(task.id);
        void adapter?.submit({
          kind: 'RetryableFailure',
          effectId: task.id,
          errorCode: 0,
          targetPhase: 'RetryWaiting',
        });
        setError(
          new UploadError(
            uploadErr.message,
            UploadErrorCode.UPLOAD_FAILED,
            uploadErr,
          ),
        );
      } finally {
        rustAdaptersByTaskId.current.delete(task.id);
        rustSubmittedTaskEvents.current.delete(task.id);
        decrementActiveUploadCount();
      }
    };

    uploadQueue.onAuthRequired = (task) => {
      setActiveTasks((prev) => prev.filter((t) => t.id !== task.id));
      showSessionExpiredToast();
      decrementActiveUploadCount();
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
      uploadQueue.onAuthRequired = undefined;
      bridgeCleanup();
    };
  }, [decrementActiveUploadCount, showSessionExpiredToast]);

  useEffect(() => {
    if (typeof subscribeToSessionExpired !== 'function') {
      return undefined;
    }

    return subscribeToSessionExpired(() => {
      void uploadQueue.pauseForAuthRequired();
      showSessionExpiredToast();
    });
  }, [showSessionExpiredToast]);

  useEffect(() => {
    return session.subscribe(() => {
      if (session.isLoggedIn) {
        dismissSessionExpiredToast();
        void uploadQueue.resumeAuthRequiredTasks();
      }
    });
  }, [dismissSessionExpiredToast]);

  // v1.0.x s49-y3: pause/resume the upload queue on browser online/offline.
  // We deliberately only latch a flag — in-flight Tus uploads keep
  // retrying via the widened retry budget — so reconnects are seamless
  // without losing already-encrypted chunks.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      uploadQueue.pauseForOffline();
    }
    const handleOffline = (): void => uploadQueue.pauseForOffline();
    const handleOnline = (): void => uploadQueue.resumeAfterOnline();
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
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
    let enqueued = false;
    incrementActiveUploadCount();
    setProgress(0);
    setError(null);

    try {
      // Initialize upload queue if needed
      await uploadQueue.init();

      let rustJobId: string | undefined;
      let rustAdapter: RustUploadAdapter | undefined;
      if (FeatureFlagsManager.load().rustCoreUpload) {
        // During the staged rollout both paths intentionally coexist: Rust core
        // owns the upload state-machine preflight while the legacy queue still
        // executes media preparation, encryption, Tus upload, and manifest work.
        try {
          rustAdapter = getRustUploadAdapter();
          rustJobId = createUuidV7();
          await rustAdapter.start({
            jobId: rustJobId,
            albumId,
            assetId: createUuidV7(),
            idempotencyKey: createUuidV7(),
            maxRetryCount: RUST_UPLOAD_MAX_RETRY_COUNT,
          });
          await rustAdapter.submit({
            kind: 'StartRequested',
            effectId: createUuidV7(),
          });
        } catch (rustErr) {
          rustJobId = undefined;
          rustAdapter = undefined;
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
        throw uploadError;
      }

      // Add file to queue with real epoch key
      log.info(
        `Adding file to upload queue: ${file.name}, albumId=${albumId}, epochId=${epochKey.epochId}`,
      );
      const taskId = rustJobId
        ? await uploadQueue.add(
          file,
          albumId,
          epochKey.epochId,
          epochKey.epochHandleId,
          rustJobId,
        )
        : await uploadQueue.add(
          file,
          albumId,
          epochKey.epochId,
          epochKey.epochHandleId,
        );
      if (rustAdapter) {
        rustAdaptersByTaskId.current.set(taskId, rustAdapter);
      }
      enqueued = true;
      log.info(`File added to upload queue: ${file.name}`);
    } catch (err) {
      if (!enqueued) {
        decrementActiveUploadCount();
      }
      // Only handle errors not already handled above
      if (!(err instanceof UploadError)) {
        log.error('Upload error:', err);
        const uploadError = new UploadError(
          err instanceof Error ? err.message : String(err),
          UploadErrorCode.UPLOAD_FAILED,
          err instanceof Error ? err : undefined,
        );
        setError(uploadError);
      }
    }
  }, [
    decrementActiveUploadCount,
    getRustUploadAdapter,
    incrementActiveUploadCount,
  ]);

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
