import { useMemo, useEffect, useState } from 'react';
import type { UploadTask } from '../../lib/upload-queue';

interface PendingPhotoThumbnailProps {
  task: UploadTask;
}

export function PendingPhotoThumbnail({ task }: PendingPhotoThumbnailProps) {
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

  const isEncrypting = task.currentAction === 'encrypting';
  const isUploading = task.currentAction === 'uploading';
  const isFinalizing = task.currentAction === 'finalizing';

  // Calculate display progress
  // Encrypting: 0-20%
  // Uploading: 20-90%
  // Finalizing: 90-100%
  const displayProgress = useMemo(() => {
    if (task.status === 'queued' || task.currentAction === 'pending') return 0;

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
    isEncrypting,
    isUploading,
    isFinalizing,
    task.progress,
  ]);

  const showProgress =
    task.status !== 'queued' && task.currentAction !== 'pending' && !task.error;

  const statusText = useMemo(() => {
    if (task.error) return 'Error';
    if (task.status === 'queued' || task.currentAction === 'pending')
      return 'Queued';
    if (isEncrypting) return 'Encrypting...';
    if (isUploading) return 'Uploading...';
    if (isFinalizing) return 'Finalizing...';
    return 'Waiting...';
  }, [
    task.status,
    task.currentAction,
    task.error,
    isEncrypting,
    isUploading,
    isFinalizing,
  ]);

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
            style={{ opacity: 0.7 }}
          />
        )}

        <div className="upload-overlay">
          {showProgress ? (
            <div className="upload-progress-container">
              <div
                className={`upload-progress-bar ${isEncrypting ? 'encrypting' : ''}`}
                style={{ width: `${displayProgress}%` }}
              />
            </div>
          ) : (
            !task.error && <div className="upload-queued-badge"></div>
          )}
          <span className="upload-status-text">{statusText}</span>
        </div>
      </div>

      {task.error && (
        <div className="photo-error-overlay">
          <span className="error-icon">⚠️</span>
        </div>
      )}
    </div>
  );
}
