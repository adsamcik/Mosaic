import { memo, useMemo, useEffect, useState } from 'react';
import type { UploadTask } from '../../lib/upload-queue';

interface PendingPhotoThumbnailProps {
  task: UploadTask;
}

export const PendingPhotoThumbnail = memo(function PendingPhotoThumbnail({ task }: PendingPhotoThumbnailProps) {
  // Create a local URL for previewing the file with proper cleanup
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(task.file);
    setPreviewUrl(url);

    // Cleanup: revoke the Object URL when component unmounts or file changes
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [task.file]);

  const isConverting = task.currentAction === 'converting';
  const isEncrypting = task.currentAction === 'encrypting';
  const isUploading = task.currentAction === 'uploading';
  const isFinalizing = task.currentAction === 'finalizing';

  // Calculate display progress
  // Converting: 0-10%
  // Encrypting: 10-20%
  // Uploading: 20-90%
  // Finalizing: 90-100%
  const displayProgress = useMemo(() => {
    if (task.status === 'queued' || task.currentAction === 'pending') return 0;

    if (isConverting) {
      // Indeterminate or fake progress for conversion
      return 5;
    }

    if (isEncrypting) {
      // Indeterminate or fake progress for encryption
      return 15;
    }

    if (isUploading) {
      // Map 0-1 to 20-90
      return 20 + task.progress * 70;
    }

    if (isFinalizing) return 95;
    if (task.status === 'complete') return 100;

    return 0;
  }, [
    task.status,
    task.currentAction,
    isConverting,
    isEncrypting,
    isUploading,
    isFinalizing,
    task.progress,
  ]);

  // Determine progress bar class
  const progressBarClass = isConverting
    ? 'converting'
    : isEncrypting
      ? 'encrypting'
      : isFinalizing
        ? 'syncing'
        : '';

  return (
    <div
      className="photo-thumbnail photo-thumbnail-pending"
      data-testid="pending-photo-thumbnail"
    >
      <div className="photo-content">
        {previewUrl && (
          <img
            src={previewUrl}
            alt={task.file.name}
            className="photo-image"
            style={{ opacity: 0.8, filter: 'brightness(0.9)' }}
          />
        )}

        <div className="upload-overlay">
          <div className="upload-progress-container">
            <div
              className={`upload-progress-bar ${progressBarClass}`}
              style={{ width: `${displayProgress}%` }}
            />
          </div>
          {task.error ? (
            <span className="upload-status upload-status--error">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span>Failed</span>
            </span>
          ) : isFinalizing ? (
            <span className="upload-status upload-status--syncing">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              <span>Finalizing</span>
            </span>
          ) : isEncrypting ? (
            <span className="upload-status upload-status--encrypting">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Encrypting</span>
            </span>
          ) : isConverting ? (
            <span className="upload-status upload-status--converting">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9" />
              </svg>
              <span>Converting</span>
            </span>
          ) : isUploading ? (
            <span className="upload-status upload-status--uploading">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>{Math.round(task.progress * 100)}%</span>
            </span>
          ) : (
            <span className="upload-status upload-status--queued">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Queued</span>
            </span>
          )}
        </div>
      </div>

      {task.error && (
        <div className="photo-error-overlay">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
      )}
    </div>
  );
});
