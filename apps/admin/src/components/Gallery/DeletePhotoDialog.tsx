/**
 * Delete Photo Dialog Component
 *
 * Modal confirmation for photo deletion.
 * Shows photo thumbnail and warning about permanent deletion.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PhotoMeta } from '../../workers/types';

export interface DeletePhotoDialogProps {
  /** Photo(s) to delete. Single photo shows thumbnail, multiple shows count */
  photos: PhotoMeta[];
  /** Thumbnail blob URL for single photo (optional) */
  thumbnailUrl?: string | undefined;
  /** Whether deletion is in progress */
  isDeleting: boolean;
  /** Callback to confirm deletion */
  onConfirm: () => void;
  /** Callback to cancel and close dialog */
  onCancel: () => void;
  /** Error message if deletion failed */
  error?: string | null | undefined;
}

/**
 * Delete Photo Dialog
 *
 * Displays a confirmation modal before deleting photos.
 * For single photo, shows thumbnail preview.
 * For bulk delete, shows count of selected photos.
 */
export function DeletePhotoDialog({
  photos,
  thumbnailUrl,
  isDeleting,
  onConfirm,
  onCancel,
  error,
}: DeletePhotoDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const isBulkDelete = photos.length > 1;
  const photoCount = photos.length;
  const singlePhoto = photos[0];

  // Focus cancel button on mount for accessibility
  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDeleting) {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, onCancel]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === dialogRef.current && !isDeleting) {
        onCancel();
      }
    },
    [isDeleting, onCancel]
  );

  // Prevent form submission refresh
  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!isDeleting) {
        onConfirm();
      }
    },
    [isDeleting, onConfirm]
  );

  return (
    <div
      ref={dialogRef}
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      data-testid="delete-photo-dialog"
    >
      <div className="dialog delete-photo-dialog">
        <form className="dialog-form" onSubmit={handleSubmit}>
          <h2 id="delete-dialog-title" className="dialog-title">
            {isBulkDelete
              ? `Delete ${photoCount} photos?`
              : 'Delete photo?'}
          </h2>

          <p className="dialog-description delete-warning">
            ⚠️ This action is permanent and cannot be undone.
            {isBulkDelete
              ? ` All ${photoCount} selected photos will be permanently deleted from the server.`
              : ' This photo will be permanently deleted from the server.'}
          </p>

          {/* Show thumbnail preview for single photo */}
          {!isBulkDelete && singlePhoto && (
            <div className="delete-photo-preview" data-testid="delete-preview">
              {thumbnailUrl ? (
                <img
                  src={thumbnailUrl}
                  alt={singlePhoto.filename}
                  className="delete-preview-image"
                />
              ) : (
                <div className="delete-preview-placeholder">
                  <span className="photo-icon">🖼️</span>
                </div>
              )}
              <div className="delete-preview-info">
                <span className="delete-preview-filename">
                  {singlePhoto.filename}
                </span>
                {singlePhoto.takenAt && (
                  <span className="delete-preview-date">
                    {new Date(singlePhoto.takenAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Show error message if deletion failed */}
          {error && (
            <p className="form-error delete-error" data-testid="delete-error">
              {error}
            </p>
          )}

          <div className="dialog-actions">
            <button
              ref={cancelButtonRef}
              type="button"
              className="button-secondary"
              onClick={onCancel}
              disabled={isDeleting}
              data-testid="delete-cancel-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button-danger"
              disabled={isDeleting}
              data-testid="delete-confirm-button"
            >
              {isDeleting ? (
                <>
                  <span className="button-spinner" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
