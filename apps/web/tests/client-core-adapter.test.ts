import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompleteCallback,
  ErrorCallback,
  PersistedTask,
  ProgressCallback,
} from '../src/lib/upload-queue';

interface MockUploadQueue {
  onProgress?: ProgressCallback;
  onComplete?: CompleteCallback;
  onError?: ErrorCallback;
  init: ReturnType<typeof vi.fn<() => Promise<void>>>;
  add: ReturnType<
    typeof vi.fn<
      (
        file: File,
        albumId: string,
        epochId: number,
        readKey: Uint8Array,
      ) => Promise<string>
    >
  >;
  cancel: ReturnType<typeof vi.fn<(taskId: string) => Promise<void>>>;
  getPendingTasks: ReturnType<typeof vi.fn<() => Promise<PersistedTask[]>>>;
  getFailedTasks: ReturnType<typeof vi.fn<() => Promise<PersistedTask[]>>>;
  getPermanentlyFailedTasks: ReturnType<
    typeof vi.fn<() => Promise<PersistedTask[]>>
  >;
  retryPermanentlyFailed: ReturnType<
    typeof vi.fn<
      (taskId: string, file: File, readKey: Uint8Array) => Promise<void>
    >
  >;
  clearPermanentlyFailedTasks: ReturnType<
    typeof vi.fn<() => Promise<number>>
  >;
}

interface MockSyncEngine {
  syncing: boolean;
  sync: ReturnType<
    typeof vi.fn<(albumId: string, readKey?: Uint8Array) => Promise<void>>
  >;
  cancel: ReturnType<typeof vi.fn<() => void>>;
  clearCache: ReturnType<typeof vi.fn<() => void>>;
  getEpochKey: ReturnType<
    typeof vi.fn<(albumId: string, epochId: number) => Uint8Array | null>
  >;
  setEpochKey: ReturnType<
    typeof vi.fn<
      (albumId: string, epochId: number, epochSeed: Uint8Array) => void
    >
  >;
  ensureEpochKeys: ReturnType<typeof vi.fn<(albumId: string) => Promise<void>>>;
  addEventListener: ReturnType<
    typeof vi.fn<
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => void
    >
  >;
  removeEventListener: ReturnType<
    typeof vi.fn<
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) => void
    >
  >;
}

const mocks = vi.hoisted(() => {
  const uploadQueue: MockUploadQueue = {
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    add: vi
      .fn<
        (
          file: File,
          albumId: string,
          epochId: number,
          readKey: Uint8Array,
        ) => Promise<string>
      >()
      .mockResolvedValue('task-1'),
    cancel: vi.fn<(taskId: string) => Promise<void>>().mockResolvedValue(),
    getPendingTasks: vi
      .fn<() => Promise<PersistedTask[]>>()
      .mockResolvedValue([]),
    getFailedTasks: vi
      .fn<() => Promise<PersistedTask[]>>()
      .mockResolvedValue([]),
    getPermanentlyFailedTasks: vi
      .fn<() => Promise<PersistedTask[]>>()
      .mockResolvedValue([]),
    retryPermanentlyFailed: vi
      .fn<(taskId: string, file: File, readKey: Uint8Array) => Promise<void>>()
      .mockResolvedValue(),
    clearPermanentlyFailedTasks: vi
      .fn<() => Promise<number>>()
      .mockResolvedValue(0),
  };

  const syncEngine: MockSyncEngine = {
    syncing: false,
    sync: vi
      .fn<(albumId: string, readKey?: Uint8Array) => Promise<void>>()
      .mockResolvedValue(undefined),
    cancel: vi.fn<() => void>(),
    clearCache: vi.fn<() => void>(),
    getEpochKey: vi
      .fn<(albumId: string, epochId: number) => Uint8Array | null>()
      .mockReturnValue(null),
    setEpochKey: vi.fn<
      (albumId: string, epochId: number, epochSeed: Uint8Array) => void
    >(),
    ensureEpochKeys: vi
      .fn<(albumId: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    addEventListener: vi.fn<
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => void
    >(),
    removeEventListener: vi.fn<
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) => void
    >(),
  };

  return { uploadQueue, syncEngine };
});

vi.mock('../src/lib/upload-queue', () => ({
  uploadQueue: mocks.uploadQueue,
}));

vi.mock('../src/lib/sync-engine', () => ({
  syncEngine: {
    get isSyncing() {
      return mocks.syncEngine.syncing;
    },
    sync: mocks.syncEngine.sync,
    cancel: mocks.syncEngine.cancel,
    clearCache: mocks.syncEngine.clearCache,
    getEpochKey: mocks.syncEngine.getEpochKey,
    setEpochKey: mocks.syncEngine.setEpochKey,
    ensureEpochKeys: mocks.syncEngine.ensureEpochKeys,
    addEventListener: mocks.syncEngine.addEventListener,
    removeEventListener: mocks.syncEngine.removeEventListener,
  },
}));

function resetQueueCallbacks(): void {
  delete mocks.uploadQueue.onProgress;
  delete mocks.uploadQueue.onComplete;
  delete mocks.uploadQueue.onError;
}

function consoleOutput(): string {
  return [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.info).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]
    .flat()
    .map((value) => String(value))
    .join('\n');
}

describe('client-core adapter seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetQueueCallbacks();
    mocks.syncEngine.syncing = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetQueueCallbacks();
    vi.restoreAllMocks();
  });

  it('selects the current TypeScript web shell implementation by default', async () => {
    const {
      DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID,
      getWebClientCoreAdapter,
      selectWebClientCoreAdapter,
    } = await import('../src/lib/client-core-adapter');

    const adapter = getWebClientCoreAdapter();

    expect(adapter.id).toBe(DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID);
    expect(adapter.runtime).toBe('typescript-web-shell');
    expect(adapter.upload.runtime).toBe('typescript-web-shell');
    expect(adapter.sync.runtime).toBe('typescript-web-shell');
    expect(selectWebClientCoreAdapter()).toBe(adapter);
    expect(selectWebClientCoreAdapter(DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID)).toBe(
      adapter,
    );
  });

  it('keeps current upload and sync singletons behind the adapter boundary', async () => {
    const { getWebClientCoreAdapter } = await import(
      '../src/lib/client-core-adapter'
    );
    const adapter = getWebClientCoreAdapter();
    const progressCallback: ProgressCallback = vi.fn();
    const completeCallback: CompleteCallback = vi.fn();
    const errorCallback: ErrorCallback = vi.fn();
    const syncListener: EventListener = vi.fn();

    adapter.upload.setProgressCallback(progressCallback);
    adapter.upload.setCompleteCallback(completeCallback);
    adapter.upload.setErrorCallback(errorCallback);
    mocks.syncEngine.syncing = true;
    adapter.sync.addEventListener('sync-complete', syncListener);

    expect(adapter.upload.getProgressCallback()).toBe(progressCallback);
    expect(adapter.upload.getCompleteCallback()).toBe(completeCallback);
    expect(adapter.upload.getErrorCallback()).toBe(errorCallback);
    expect(adapter.sync.isSyncing).toBe(true);
    expect(mocks.syncEngine.addEventListener).toHaveBeenCalledWith(
      'sync-complete',
      syncListener,
      undefined,
    );

    adapter.upload.clearProgressCallback();
    adapter.upload.clearCompleteCallback();
    adapter.upload.clearErrorCallback();

    expect(adapter.upload.getProgressCallback()).toBeUndefined();
    expect(adapter.upload.getCompleteCallback()).toBeUndefined();
    expect(adapter.upload.getErrorCallback()).toBeUndefined();
  });

  it('does not echo plaintext keys, media, or metadata in selection logs or errors', async () => {
    const { selectWebClientCoreAdapter } = await import(
      '../src/lib/client-core-adapter'
    );
    const sensitiveValues = [
      'PLAINTEXT_KEY_BYTES_123',
      'RAW_MEDIA_BYTES_456',
      'GPS_METADATA_789',
    ];

    let thrown: unknown;
    try {
      selectWebClientCoreAdapter(`rust:${sensitiveValues.join(':')}`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Unsupported web client-core adapter selection',
    );
    for (const sensitiveValue of sensitiveValues) {
      expect((thrown as Error).message).not.toContain(sensitiveValue);
      expect(consoleOutput()).not.toContain(sensitiveValue);
    }
    expect(console.log).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
