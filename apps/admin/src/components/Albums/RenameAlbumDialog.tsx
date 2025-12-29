import { useEffect, useRef, useState } from 'react';

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
  const dialogRef = useRef<HTMLDialogElement>(null);

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

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isRenaming) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isRenaming, onClose]);

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

  const handleBackdropClick = (e: React.MouseEvent) => {
    // Only close if clicking the backdrop itself, not the dialog content
    if (e.target === e.currentTarget && !isRenaming) {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  const displayError = localError || error;
  const hasChanged = name.trim() !== currentName;

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
      data-testid="rename-album-backdrop"
    >
      <dialog
        ref={dialogRef}
        className="dialog"
        open
        aria-labelledby="rename-album-title"
        aria-modal="true"
        data-testid="rename-album-dialog"
      >
        <form onSubmit={handleSubmit} className="dialog-form">
          <h2 id="rename-album-title" className="dialog-title">
            Rename Album
          </h2>

          <p className="dialog-description">
            Album names are encrypted - only you and invited members can see them.
          </p>

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

          <div className="dialog-actions">
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
              disabled={isRenaming || !name.trim() || !hasChanged}
              className="button-primary"
              data-testid="rename-album-save-button"
            >
              {isRenaming ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
