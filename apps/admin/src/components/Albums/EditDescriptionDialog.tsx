import { useEffect, useRef, useState } from 'react';

interface EditDescriptionDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Called to update the description */
  onSave: (description: string | null) => Promise<void>;
  /** Whether save is in progress */
  isSaving: boolean;
  /** Error message to display */
  error: string | null;
  /** Current album description (for pre-populating input) */
  currentDescription: string | null;
}

/**
 * Edit Description Dialog Component
 *
 * Modal dialog for editing an album description.
 * The description will be encrypted client-side before sending to server.
 */
export function EditDescriptionDialog({
  isOpen,
  onClose,
  onSave,
  isSaving,
  error,
  currentDescription,
}: EditDescriptionDialogProps) {
  const [description, setDescription] = useState(currentDescription ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Reset form when dialog opens with current description
  useEffect(() => {
    if (isOpen) {
      setDescription(currentDescription ?? '');
      setLocalError(null);
      // Focus textarea when dialog opens
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
    }
  }, [isOpen, currentDescription]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isSaving) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedDescription = description.trim();
    
    if (trimmedDescription.length > 1000) {
      setLocalError('Description must be 1000 characters or less');
      return;
    }

    // Don't submit if description hasn't changed
    if (trimmedDescription === (currentDescription ?? '')) {
      onClose();
      return;
    }

    setLocalError(null);

    try {
      // Pass null to clear description, otherwise pass the trimmed value
      await onSave(trimmedDescription || null);
      // onSave should close the dialog on success
    } catch {
      // Error is handled by parent via error prop
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    // Only close if clicking the backdrop itself, not the dialog content
    if (e.target === e.currentTarget && !isSaving) {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  const displayError = localError || error;

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      data-testid="edit-description-dialog-backdrop"
    >
      <dialog
        ref={dialogRef}
        className="dialog"
        open
        aria-labelledby="edit-description-title"
        data-testid="edit-description-dialog"
      >
        <form onSubmit={handleSubmit}>
          <h2 id="edit-description-title">Edit Album Description</h2>

          <div className="form-field">
            <label htmlFor="album-description">Description</label>
            <textarea
              ref={textareaRef}
              id="album-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSaving}
              placeholder="Add a description for this album..."
              rows={4}
              maxLength={1000}
              data-testid="edit-description-input"
            />
            <div className="form-field-hint">
              {description.length}/1000 characters
            </div>
          </div>

          {displayError && (
            <div className="form-error" role="alert" data-testid="edit-description-error">
              {displayError}
            </div>
          )}

          <div className="dialog-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
              disabled={isSaving}
              data-testid="edit-description-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={isSaving}
              data-testid="edit-description-save"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
