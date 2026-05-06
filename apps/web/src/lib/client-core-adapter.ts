import { syncEngine, type SyncEventType } from './sync-engine';
import {
  uploadQueue,
  type CompleteCallback,
  type ErrorCallback,
  type PersistedTask,
  type ProgressCallback,
} from './upload-queue';
import type { EpochHandleId } from '../workers/types';

export const DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID =
  'web-current-upload-sync' as const;

export type WebClientCoreAdapterId =
  typeof DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID;

export type WebClientCoreRuntime = 'typescript-web-shell';

export interface WebUploadAdapter {
  readonly runtime: WebClientCoreRuntime;
  init(): Promise<void>;
  add(
    file: File,
    albumId: string,
    epochId: number,
    epochHandleId: EpochHandleId,
  ): Promise<string>;
  cancel(taskId: string): Promise<void>;
  getPendingTasks(): Promise<PersistedTask[]>;
  getFailedTasks(): Promise<PersistedTask[]>;
  getPermanentlyFailedTasks(): Promise<PersistedTask[]>;
  retryPermanentlyFailed(
    taskId: string,
    file: File,
    epochHandleId: EpochHandleId,
  ): Promise<void>;
  clearPermanentlyFailedTasks(): Promise<number>;
  getProgressCallback(): ProgressCallback | undefined;
  setProgressCallback(callback: ProgressCallback): void;
  clearProgressCallback(): void;
  getCompleteCallback(): CompleteCallback | undefined;
  setCompleteCallback(callback: CompleteCallback): void;
  clearCompleteCallback(): void;
  getErrorCallback(): ErrorCallback | undefined;
  setErrorCallback(callback: ErrorCallback): void;
  clearErrorCallback(): void;
}

export interface WebSyncAdapter {
  readonly runtime: WebClientCoreRuntime;
  readonly isSyncing: boolean;
  sync(albumId: string, epochHandleId?: EpochHandleId): Promise<void>;
  cancel(): void;
  clearCache(): void;
  getEpochKey(albumId: string, epochId: number): EpochHandleId | null;
  setEpochKey(albumId: string, epochId: number, epochHandleId: EpochHandleId): void;
  ensureEpochKeys(albumId: string): Promise<void>;
  addEventListener(
    type: SyncEventType,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: SyncEventType,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface WebClientCoreAdapter {
  readonly id: WebClientCoreAdapterId;
  readonly runtime: WebClientCoreRuntime;
  readonly upload: WebUploadAdapter;
  readonly sync: WebSyncAdapter;
}

const runtime: WebClientCoreRuntime = 'typescript-web-shell';

const currentUploadAdapter: WebUploadAdapter = {
  runtime,
  init: () => uploadQueue.init(),
  add: (file, albumId, epochId, epochHandleId) =>
    uploadQueue.add(file, albumId, epochId, epochHandleId),
  cancel: (taskId) => uploadQueue.cancel(taskId),
  getPendingTasks: () => uploadQueue.getPendingTasks(),
  getFailedTasks: () => uploadQueue.getFailedTasks(),
  getPermanentlyFailedTasks: () => uploadQueue.getPermanentlyFailedTasks(),
  retryPermanentlyFailed: (taskId, file, epochHandleId) =>
    uploadQueue.retryPermanentlyFailed(taskId, file, epochHandleId),
  clearPermanentlyFailedTasks: () => uploadQueue.clearPermanentlyFailedTasks(),
  getProgressCallback: () => uploadQueue.onProgress,
  setProgressCallback: (callback) => {
    uploadQueue.onProgress = callback;
  },
  clearProgressCallback: () => {
    delete uploadQueue.onProgress;
  },
  getCompleteCallback: () => uploadQueue.onComplete,
  setCompleteCallback: (callback) => {
    uploadQueue.onComplete = callback;
  },
  clearCompleteCallback: () => {
    delete uploadQueue.onComplete;
  },
  getErrorCallback: () => uploadQueue.onError,
  setErrorCallback: (callback) => {
    uploadQueue.onError = callback;
  },
  clearErrorCallback: () => {
    delete uploadQueue.onError;
  },
};

const currentSyncAdapter: WebSyncAdapter = {
  runtime,
  get isSyncing() {
    return syncEngine.isSyncing;
  },
  sync: (albumId, epochHandleId) => syncEngine.sync(albumId, epochHandleId),
  cancel: () => syncEngine.cancel(),
  clearCache: () => syncEngine.clearCache(),
  getEpochKey: (albumId, epochId) => syncEngine.getEpochKey(albumId, epochId),
  setEpochKey: (albumId, epochId, epochHandleId) =>
    syncEngine.setEpochKey(albumId, epochId, epochHandleId),
  ensureEpochKeys: (albumId) => syncEngine.ensureEpochKeys(albumId),
  addEventListener: (type, listener, options) => {
    syncEngine.addEventListener(type, listener, options);
  },
  removeEventListener: (type, listener, options) => {
    syncEngine.removeEventListener(type, listener, options);
  },
};

const currentWebClientCoreAdapter: WebClientCoreAdapter = {
  id: DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID,
  runtime,
  upload: currentUploadAdapter,
  sync: currentSyncAdapter,
};

export function selectWebClientCoreAdapter(
  adapterId: string = DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID,
): WebClientCoreAdapter {
  if (adapterId !== DEFAULT_WEB_CLIENT_CORE_ADAPTER_ID) {
    throw new Error('Unsupported web client-core adapter selection');
  }

  return currentWebClientCoreAdapter;
}

export function getWebClientCoreAdapter(): WebClientCoreAdapter {
  return selectWebClientCoreAdapter();
}
