import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../Shared/Dialog';

interface RenameAlbumDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Called to rename the album */
  onRename: (newName: string) => Promise<void>;
  /** Whether rename is in progress */
  isRenaming: boolean;
  /** Error message to display */
  error: string | null;
  /** Current album name (for pre-populating input) */
  currentName: string;
}

/**
 * Rename Album Dialog Component
 *
 * Modal dialog for renaming an existing album.
 * The new name will be encrypted client-side before sending to server.
 */
export function RenameAlbumDialog({
  isOpen,
  onClose,
  onRename,
  isRenaming,
  error,
  currentName,
}: RenameAlbumDialogProps) {
  const [name, setName] = useState(currentName);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset form when dialog opens with current name
  useEffect(() => {
    if (isOpen) {
      setName(currentName);
      setLocalError(null);
      // Focus input when dialog opens
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [isOpen, currentName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError('Album name is required');
      return;
    }

    if (trimmedName.length > 100) {
      setLocalError('Album name must be 100 characters or less');
      return;
    }

    // Don't submit if name hasn't changed
    if (trimmedName === currentName) {
      onClose();
      return;
    }

    setLocalError(null);

    try {
      await onRename(trimmedName);
      // onRename should close the dialog on success
    } catch {
      // Error is handled by parent via error prop
    }
  };

  const displayError = localError || error;
  const hasChanged = name.trim() !== currentName;

  const footer = (
    <>
      <button
        type="button"
        onClick={onClose}
        disabled={isRenaming}
        className="button-secondary"
        data-testid="rename-album-cancel-button"
      >
        Cancel
      </button>
      <button
        type="submit"
        form="rename-album-form"
        disabled={isRenaming || !name.trim() || !hasChanged}
        className="button-primary"
        data-testid="rename-album-save-button"
      >
        {isRenaming ? 'Saving...' : 'Save'}
      </button>
    </>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Rename Album"
      description="Album names are encrypted - only you and invited members can see them."
      footer={footer}
      testId="rename-album-dialog"
      closeOnBackdropClick={!isRenaming}
    >
      <form onSubmit={handleSubmit} className="dialog-form" id="rename-album-form">
        <div className="form-group">
          <label htmlFor="rename-album-name" className="form-label">
            Album Name
          </label>
          <input
            ref={inputRef}
            id="rename-album-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Photos"
            disabled={isRenaming}
            className="form-input"
            autoComplete="off"
            maxLength={100}
            aria-describedby={displayError ? 'rename-album-error' : undefined}
            data-testid="rename-album-name-input"
          />
        </div>

        {displayError && (
          <div
            id="rename-album-error"
            className="form-error"
            role="alert"
            data-testid="rename-album-error"
          >
            {displayError}
          </div>
        )}
      </form>
    </Dialog>
  );
}
