import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Shared/Dialog';

interface CreateAlbumDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Called to create an album */
  onCreate: (name: string) => Promise<void>;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** Error message to display */
  error: string | null;
}

/**
 * Create Album Dialog Component
 *
 * Modal dialog for creating a new album with encrypted name.
 * Handles form state, validation, and accessibility.
 */
export function CreateAlbumDialog({
  isOpen,
  onClose,
  onCreate,
  isCreating,
  error,
}: CreateAlbumDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure dialog is rendered
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [isOpen]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setName('');
      setLocalError(null);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isCreating) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isCreating, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError(t('album.create.error.nameRequired'));
      return;
    }

    if (trimmedName.length > 100) {
      setLocalError(t('album.create.error.nameTooLong'));
      return;
    }

    setLocalError(null);

    try {
      await onCreate(trimmedName);
      // onCreate should close the dialog on success
    } catch {
      // Error is handled by parent via error prop
    }
  };

  if (!isOpen) {
    return null;
  }

  const displayError = localError || error;

  const footer = (
    <>
      <button
        type="button"
        onClick={onClose}
        disabled={isCreating}
        className="button-secondary"
        data-testid="cancel-button"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        form="create-album-form"
        disabled={isCreating || !name.trim()}
        className="button-primary"
        data-testid="create-button"
      >
        {isCreating ? t('album.create.creating') : t('album.create.submit')}
      </button>
    </>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('album.create.title')}
      description={t('album.create.description')}
      footer={footer}
      testId="create-album-dialog"
      closeOnBackdropClick={!isCreating}
    >
      <form onSubmit={handleSubmit} className="dialog-form" id="create-album-form">
        <div className="form-group">
          <label htmlFor="album-name" className="form-label">
            {t('album.create.nameLabel')}
          </label>
          <input
            ref={inputRef}
            id="album-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('album.create.namePlaceholder')}
            disabled={isCreating}
            className="form-input"
            autoComplete="off"
            maxLength={100}
            aria-describedby={displayError ? 'album-error' : undefined}
            data-testid="album-name-input"
          />
        </div>

        {displayError && (
          <div
            id="album-error"
            className="form-error"
            role="alert"
            data-testid="create-album-error"
          >
            {displayError}
          </div>
        )}
      </form>
    </Dialog>
  );
}
