import { useState, useCallback } from 'react';
import { uploadQueue } from '../lib/upload-queue';

/**
 * Hook for file upload functionality
 */
export function useUpload() {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const upload = useCallback(async (file: File, albumId: string) => {
    setIsUploading(true);
    setProgress(0);

    try {
      // Initialize upload queue if needed
      await uploadQueue.init();

      // TODO: Get epoch key from album
      // For now, use placeholder values
      const epochId = 1;
      const readKey = new Uint8Array(32);

      // Set up progress callback
      uploadQueue.onProgress = (task) => {
        setProgress(task.progress);
      };

      uploadQueue.onComplete = () => {
        setIsUploading(false);
        setProgress(1);
      };

      uploadQueue.onError = (_, error) => {
        console.error('Upload failed:', error);
        setIsUploading(false);
      };

      // Add file to queue
      await uploadQueue.add(file, albumId, epochId, readKey);
    } catch (error) {
      console.error('Upload error:', error);
      setIsUploading(false);
    }
  }, []);

  return { upload, isUploading, progress };
}
