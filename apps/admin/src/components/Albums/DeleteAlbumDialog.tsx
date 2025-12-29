/**
 * Delete Album Dialog Component
 *
 * Modal confirmation for album deletion.
 * Shows album name and warning about permanent deletion.
 */

import { Dialog } from '../Shared/Dialog';

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
  
  const footer = (
    <>
      <button
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
        form="delete-album-form"
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
    </>
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isDeleting) {
      onConfirm();
    }
  };

  return (
    <Dialog
      isOpen={true} // Controlled by parent rendering this component
      onClose={onCancel}
      title="Delete album?"
      footer={footer}
      testId="delete-album-dialog"
      closeOnBackdropClick={!isDeleting}
    >
      <form id="delete-album-form" className="dialog-form" onSubmit={handleSubmit}>
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
      </form>
    </Dialog>
  );
}
