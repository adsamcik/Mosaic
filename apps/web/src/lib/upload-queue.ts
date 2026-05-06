/**
 * Re-export from the decomposed upload module.
 * This file preserves backward compatibility for existing imports.
 */
export {
  uploadQueue,
  LegacyUploadQueueDrainer,
  IndexedDbLegacyUploadQueueStore,
  createIdempotencyKey,
  createUuidV7,
  isUuidV7,
  legacyUploadQueueDrainer,
  legacyUploadTelemetry,
  SNAPSHOT_VERSION,
  type UploadTask,
  type UploadStatus,
  type UploadAction,
  type CompletedShard,
  type TieredUploadResult,
  type VideoUploadMetadata,
  type PersistedTask,
  type ProgressCallback,
  type CompleteCallback,
  type ErrorCallback,
  type CurrentUploadRecord,
  type LegacyUploadDetection,
  type LegacyUploadDrainResult,
  type LegacyUploadQueueStoreAdapter,
  type LegacyUploadRecord,
  type LegacyUploadTelemetryCounter,
  type LegacyUploadTelemetrySnapshot,
} from './upload/index';
