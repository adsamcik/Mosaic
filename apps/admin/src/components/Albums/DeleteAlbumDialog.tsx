/**
 * Delete Album Dialog Component
 *
 * Modal confirmation for album deletion.
 * Shows album name and warning about permanent deletion.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface DeleteAlbumDialogProps {
  /** Album name to display */
  albumName: string;
  /** Photo count in album */
  photoCount: number;
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
 * Delete Album Dialog
 *
 * Displays a confirmation modal before deleting an album.
 * Shows album name and photo count for user awareness.
 */
export function DeleteAlbumDialog({
  albumName,
  photoCount,
  isDeleting,
  onConfirm,
  onCancel,
  error,
}: DeleteAlbumDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

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
      aria-labelledby="delete-album-dialog-title"
      data-testid="delete-album-dialog"
    >
      <div className="dialog delete-album-dialog">
        <form className="dialog-form" onSubmit={handleSubmit}>
          <h2 id="delete-album-dialog-title" className="dialog-title">
            Delete album?
          </h2>

          <p className="dialog-description delete-warning">
            ⚠️ This action is permanent and cannot be undone.
          </p>

          <div className="delete-album-info" data-testid="delete-album-info">
            <p className="album-name-display">
              <strong>Album:</strong> {albumName}
            </p>
            <p className="photo-count-display">
              <strong>Photos:</strong> {photoCount} {photoCount === 1 ? 'photo' : 'photos'} will be permanently deleted.
            </p>
          </div>

          {/* Show error message if deletion failed */}
          {error && (
            <p className="form-error delete-error" data-testid="delete-album-error">
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
              data-testid="delete-album-cancel-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button-danger"
              disabled={isDeleting}
              data-testid="delete-album-confirm-button"
            >
              {isDeleting ? (
                <>
                  <span className="button-spinner" />
                  Deleting...
                </>
              ) : (
                'Delete Album'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
