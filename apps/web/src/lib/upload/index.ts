// Barrel export — preserves the original public API from lib/upload-queue.ts
export { uploadQueue } from './upload-queue';
export {
  LegacyUploadQueueDrainer,
  IndexedDbLegacyUploadQueueStore,
  createIdempotencyKey,
  createUuidV7,
  isUuidV7,
  legacyUploadQueueDrainer,
  legacyUploadTelemetry,
  SNAPSHOT_VERSION,
} from './legacy-drainer';
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
