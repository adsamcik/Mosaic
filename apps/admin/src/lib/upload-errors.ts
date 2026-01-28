/**
 * Centralized upload error types.
 * Used by UploadContext and useUpload hook.
 */

/** Error thrown when upload fails */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: UploadErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Upload error codes */
export enum UploadErrorCode {
  /** Failed to get epoch key for album */
  EPOCH_KEY_FAILED = 'EPOCH_KEY_FAILED',
  /** Upload queue not initialized */
  QUEUE_NOT_INITIALIZED = 'QUEUE_NOT_INITIALIZED',
  /** Generic upload error */
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  /** Failed to create manifest after upload */
  MANIFEST_FAILED = 'MANIFEST_FAILED',
}
