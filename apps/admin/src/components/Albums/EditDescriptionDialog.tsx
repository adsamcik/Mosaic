import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../Shared/Dialog';

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

  const displayError = localError || error;

  const footer = (
    <>
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
        form="edit-description-form"
        className="button-primary"
        disabled={isSaving}
        data-testid="edit-description-save"
      >
        {isSaving ? 'Saving...' : 'Save'}
      </button>
    </>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Album Description"
      footer={footer}
      testId="edit-description-dialog"
      closeOnBackdropClick={!isSaving}
    >
      <form onSubmit={handleSubmit} id="edit-description-form">
        <div className="form-field">
          <label htmlFor="album-description" className="form-label">
            Description
          </label>
          <textarea
            ref={textareaRef}
            id="album-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isSaving}
            placeholder="Add a description for this album..."
            rows={4}
            maxLength={1000}
            className="form-input"
            data-testid="edit-description-input"
            style={{ resize: 'vertical', minHeight: '100px' }}
          />
          <div
            className="form-field-hint"
            style={{
              marginTop: '8px',
              fontSize: '0.8rem',
              color: 'var(--color-text-tertiary)',
            }}
          >
            {description.length}/1000 characters
          </div>
        </div>

        {displayError && (
          <div
            className="form-error"
            role="alert"
            data-testid="edit-description-error"
          >
            {displayError}
          </div>
        )}
      </form>
    </Dialog>
  );
}
