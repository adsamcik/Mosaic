import { useCallback, useState } from 'react';
import { getCurrentOrFetchEpochKey } from '../lib/epoch-key-service';
import { type EpochKeyBundle } from '../lib/epoch-key-store';
import { createLogger } from '../lib/logger';
import { createManifestForUpload } from '../lib/manifest-service';
import { UploadError, UploadErrorCode } from '../lib/upload-errors';
import { uploadQueue } from '../lib/upload-queue';

// Re-export for consumers
export { UploadError, UploadErrorCode } from '../lib/upload-errors';

const log = createLogger('useUpload');

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
        setIsUploading(false);
        throw uploadError;
      }

      // Set up progress callback
      uploadQueue.onProgress = (task) => {
        setProgress(task.progress);
      };

      // Create manifest when upload completes
      uploadQueue.onComplete = async (task, shardIds, tieredShards) => {
        try {
          await createManifestForUpload(task, shardIds, epochKey, tieredShards);
          setIsUploading(false);
          setProgress(1);
        } catch (manifestErr) {
          log.error('Failed to create manifest:', manifestErr);
          setError(
            new UploadError(
              `Upload succeeded but manifest creation failed: ${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}`,
              UploadErrorCode.MANIFEST_FAILED,
              manifestErr instanceof Error ? manifestErr : undefined,
            ),
          );
          setIsUploading(false);
        }
      };

      uploadQueue.onError = (_, uploadErr) => {
        log.error('Upload failed:', uploadErr);
        setError(
          new UploadError(
            uploadErr.message,
            UploadErrorCode.UPLOAD_FAILED,
            uploadErr,
          ),
        );
        setIsUploading(false);
      };

      // Add file to queue with real epoch key
      await uploadQueue.add(
        file,
        albumId,
        epochKey.epochId,
        epochKey.epochSeed,
      );
    } catch (err) {
      // Only handle errors not already handled above
      if (!(err instanceof UploadError)) {
        log.error('Upload error:', err);
        const uploadError = new UploadError(
          err instanceof Error ? err.message : String(err),
          UploadErrorCode.UPLOAD_FAILED,
          err instanceof Error ? err : undefined,
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
