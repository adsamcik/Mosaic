/**
 * Re-export from the decomposed upload module.
 * This file preserves backward compatibility for existing imports.
 */
export {
  uploadQueue,
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
} from './upload/index';
