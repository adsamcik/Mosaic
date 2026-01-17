/**
 * Delete Photo Dialog Component
 *
 * Modal confirmation for photo deletion.
 * Shows photo thumbnail and warning about permanent deletion.
 */

import { useTranslation } from 'react-i18next';
import type { PhotoMeta } from '../../workers/types';
import { Dialog } from '../Shared/Dialog';

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
  const { t } = useTranslation();
  const isBulkDelete = photos.length > 1;
  const photoCount = photos.length;
  const singlePhoto = photos[0];

  const footer = (
    <>
      <button
        type="button"
        className="button-secondary"
        onClick={onCancel}
        disabled={isDeleting}
        data-testid="delete-cancel-button"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        form="delete-photo-form"
        className="button-danger"
        disabled={isDeleting}
        data-testid="delete-confirm-button"
      >
        {isDeleting ? (
          <>
            <span className="button-spinner" />
            {t('common.deleting')}
          </>
        ) : (
          t('common.delete')
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

  const title = isBulkDelete
    ? t('gallery.delete.titleBulk', { count: photoCount })
    : t('gallery.delete.titleSingle');

  return (
    <Dialog
      isOpen={true} // Controlled by parent
      onClose={onCancel}
      title={title}
      footer={footer}
      testId="delete-photo-dialog"
      closeOnBackdropClick={!isDeleting}
    >
      <form
        id="delete-photo-form"
        className="dialog-form"
        onSubmit={handleSubmit}
      >
        <p className="dialog-description delete-warning">
          {t('common.permanentAction')}{' '}
          {isBulkDelete
            ? t('gallery.delete.warningBulk', { count: photoCount })
            : t('gallery.delete.warningSingle')}
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
      </form>
    </Dialog>
  );
}
