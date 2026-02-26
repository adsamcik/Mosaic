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

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      // Prevent body scroll when dialog is open
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  // Focus management
  useEffect(() => {
    if (isOpen) {
      // Small timeout to allow render
      const timer = setTimeout(() => {
        dialogRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (closeOnBackdropClick && e.target === e.currentTarget) {
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
        open
        aria-labelledby={`${testId}-title`}
        aria-modal="true"
        data-testid={testId}
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
