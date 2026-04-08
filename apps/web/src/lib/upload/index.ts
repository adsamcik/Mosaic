// Barrel export — preserves the original public API from lib/upload-queue.ts
export { uploadQueue } from './upload-queue';
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
