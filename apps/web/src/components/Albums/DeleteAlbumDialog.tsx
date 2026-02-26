/**
 * Delete Album Dialog Component
 *
 * Modal confirmation for album deletion.
 * Shows album name and warning about permanent deletion.
 */

import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();

  const footer = (
    <>
      <button
        type="button"
        className="button-secondary"
        onClick={onCancel}
        disabled={isDeleting}
        data-testid="delete-album-cancel-button"
      >
        {t('common.cancel')}
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
            {t('common.deleting')}
          </>
        ) : (
          t('album.delete.confirm')
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
      title={t('album.delete.title')}
      footer={footer}
      testId="delete-album-dialog"
      closeOnBackdropClick={!isDeleting}
    >
      <form
        id="delete-album-form"
        className="dialog-form"
        onSubmit={handleSubmit}
      >
        <p className="dialog-description delete-warning">
          {t('common.permanentAction')}
        </p>

        <div className="delete-album-info" data-testid="delete-album-info">
          <p className="album-name-display">
            <strong>{t('album.title')}:</strong> {albumName}
          </p>
          <p className="photo-count-display">
            {t('album.delete.photoCount', { count: photoCount })}
          </p>
        </div>

        {/* Show error message if deletion failed */}
        {error && (
          <p
            className="form-error delete-error"
            data-testid="delete-album-error"
          >
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
