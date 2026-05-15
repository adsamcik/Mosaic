// Barrel export for the upload module public API.
export { uploadQueue } from './upload-queue';
export {
  LegacyUploadQueueDrainer,
  IndexedDbLegacyUploadQueueStore,
  createIdempotencyKey,
  createUuidV7,
  isUuidV7,
  legacyUploadQueueDrainer,
  legacyUploadTelemetry,
} from './legacy-drainer';
export { SNAPSHOT_VERSION } from './constants';
export type {
  CurrentUploadRecord,
  LegacyUploadDetection,
  LegacyUploadDrainResult,
  LegacyUploadQueueStoreAdapter,
  LegacyUploadRecord,
  LegacyUploadTelemetryCounter,
  LegacyUploadTelemetrySnapshot,
} from './legacy-drainer';
export type {
  UploadTask,
  UploadStatus,
  UploadAction,
  CompletedShard,
  TieredUploadResult,
  VideoUploadMetadata,
  PersistedTask,
  ProgressCallback,
  CompleteCallback,
  ErrorCallback,
} from './types';
