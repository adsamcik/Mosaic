import { useCallback, useState } from 'react';
import { getCurrentOrFetchEpochKey } from '../lib/epoch-key-service';
import { uploadQueue } from '../lib/upload-queue';

/** Error thrown when upload fails */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: UploadErrorCode,
    public readonly cause?: Error
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
}

/**
 * Hook for file upload functionality
 */
export function useUpload() {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);

  const upload = useCallback(async (file: File, albumId: string) => {
    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Initialize upload queue if needed
      await uploadQueue.init();

      // Get the current epoch key for this album
      let epochKey;
      try {
        epochKey = await getCurrentOrFetchEpochKey(albumId);
      } catch (err) {
        const uploadError = new UploadError(
          `Failed to get epoch key for album: ${err instanceof Error ? err.message : String(err)}`,
          UploadErrorCode.EPOCH_KEY_FAILED,
          err instanceof Error ? err : undefined
        );
        setError(uploadError);
        setIsUploading(false);
        throw uploadError;
      }

      // Set up progress callback
      uploadQueue.onProgress = (task) => {
        setProgress(task.progress);
      };

      uploadQueue.onComplete = () => {
        setIsUploading(false);
        setProgress(1);
      };

      uploadQueue.onError = (_, uploadErr) => {
        console.error('Upload failed:', uploadErr);
        setError(
          new UploadError(
            uploadErr.message,
            UploadErrorCode.UPLOAD_FAILED,
            uploadErr
          )
        );
        setIsUploading(false);
      };

      // Add file to queue with real epoch key
      await uploadQueue.add(
        file,
        albumId,
        epochKey.epochId,
        epochKey.epochSeed
      );
    } catch (err) {
      // Only handle errors not already handled above
      if (!(err instanceof UploadError)) {
        console.error('Upload error:', err);
        const uploadError = new UploadError(
          err instanceof Error ? err.message : String(err),
          UploadErrorCode.UPLOAD_FAILED,
          err instanceof Error ? err : undefined
        );
        setError(uploadError);
        setIsUploading(false);
      }
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { upload, isUploading, progress, error, clearError };
}
