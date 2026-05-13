import { useEffect, useRef } from 'react';

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  testId?: string;
  closeOnBackdropClick?: boolean;
}

/**
 * Reusable Dialog Component
 *
 * Implements a standard modal dialog with:
 * - Backdrop with blur effect
 * - Centered content
 * - Keyboard navigation (Escape to close)
 * - Focus management
 * - Consistent styling
 */
export function Dialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  className = '',
  testId = 'dialog',
  closeOnBackdropClick = true,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const handledEscapeRef = useRef(false);

  // Handle Escape and prevent body scroll when dialog is open.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handledEscapeRef.current = true;
        onClose();
        setTimeout(() => {
          handledEscapeRef.current = false;
        }, 0);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  // Native modal dialog provides focus trapping and inert background content.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) {
      return;
    }

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }

    const timer = setTimeout(() => {
      dialog.focus();
    }, 50);

    return () => {
      clearTimeout(timer);
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    };
  }, [isOpen]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (closeOnBackdropClick && e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    if (handledEscapeRef.current) {
      return;
    }
    onClose();
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape' && typeof dialogRef.current?.showModal !== 'function') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
      data-testid={`${testId}-backdrop`}
    >
      <dialog
        ref={dialogRef}
        className={`dialog ${className}`}
        aria-labelledby={`${testId}-title`}
        aria-modal="true"
        data-testid={testId}
        onCancel={handleCancel}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="dialog-header">
          <h2 id={`${testId}-title`} className="dialog-title">
            {title}
          </h2>
          {description && <p className="dialog-description">{description}</p>}
        </div>

        <div className="dialog-content">{children}</div>

        {footer && <div className="dialog-actions">{footer}</div>}
      </dialog>
    </div>
  );
}
