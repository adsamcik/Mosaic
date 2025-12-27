/**
 * InviteMemberDialog Component
 *
 * Modal dialog for inviting new members to an album.
 * Handles user lookup, role selection, and invite flow.
 */

import { useEffect, useRef, useState } from 'react';
import type { UserPublic } from '../../lib/api-types';

interface InviteMemberDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Called to invite a member */
  onInvite: (recipientId: string, role: 'editor' | 'viewer') => Promise<void>;
  /** Lookup user by ID or pubkey */
  lookupUser: (query: string) => Promise<UserPublic>;
  /** Whether invite is in progress */
  isInviting: boolean;
  /** Whether lookup is in progress */
  isLookingUp: boolean;
  /** Error message to display */
  error: string | null;
}

/**
 * InviteMemberDialog Component
 *
 * Provides a modal for:
 * - Searching/looking up users by ID or identity pubkey
 * - Selecting role (viewer or editor)
 * - Triggering the invite flow
 */
export function InviteMemberDialog({
  isOpen,
  onClose,
  onInvite,
  lookupUser,
  isInviting,
  isLookingUp,
  error,
}: InviteMemberDialogProps) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  const [localError, setLocalError] = useState<string | null>(null);
  const [foundUser, setFoundUser] = useState<UserPublic | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [isOpen]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setRole('viewer');
      setLocalError(null);
      setFoundUser(null);
      setLookupError(null);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isInviting) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isInviting, onClose]);

  const handleLookup = async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setLocalError('Please enter a user ID or identity public key');
      return;
    }

    setLocalError(null);
    setLookupError(null);
    setFoundUser(null);

    try {
      const user = await lookupUser(trimmedQuery);
      setFoundUser(user);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'User not found';
      setLookupError(message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!foundUser) {
      setLocalError('Please look up a user first');
      return;
    }

    setLocalError(null);

    try {
      await onInvite(foundUser.id, role);
      // onInvite should close the dialog on success
    } catch {
      // Error is handled by parent via error prop
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isInviting) {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  const displayError = localError || lookupError || error;
  const isProcessing = isInviting || isLookingUp;

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
      data-testid="invite-dialog-backdrop"
    >
      <dialog
        ref={dialogRef}
        className="dialog"
        open
        aria-labelledby="invite-member-title"
        aria-modal="true"
        data-testid="invite-member-dialog"
      >
        <form onSubmit={handleSubmit} className="dialog-form">
          <h2 id="invite-member-title" className="dialog-title">
            Invite Member
          </h2>

          <p className="dialog-description">
            Enter a user ID or identity public key to invite someone to this album.
            They will receive access to all epoch keys.
          </p>

          <div className="form-group">
            <label htmlFor="user-query" className="form-label">
              User ID or Public Key
            </label>
            <div className="input-with-button">
              <input
                ref={inputRef}
                id="user-query"
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFoundUser(null);
                  setLookupError(null);
                }}
                placeholder="Enter user ID or paste identity pubkey"
                disabled={isProcessing}
                className="form-input"
                autoComplete="off"
                aria-describedby={displayError ? 'invite-error' : undefined}
                data-testid="user-query-input"
              />
              <button
                type="button"
                className="button-secondary lookup-button"
                onClick={handleLookup}
                disabled={isProcessing || !query.trim()}
                data-testid="lookup-button"
              >
                {isLookingUp ? 'Looking...' : 'Look Up'}
              </button>
            </div>
          </div>

          {foundUser && (
            <div className="found-user" data-testid="found-user">
              <span className="found-user-icon">✓</span>
              <div className="found-user-details">
                <span className="found-user-label">User found:</span>
                <span className="found-user-id">{foundUser.id.slice(0, 16)}...</span>
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Role</label>
            <div className="role-selector" data-testid="role-selector">
              <label className="role-option">
                <input
                  type="radio"
                  name="role"
                  value="viewer"
                  checked={role === 'viewer'}
                  onChange={() => setRole('viewer')}
                  disabled={isProcessing}
                />
                <span className="role-option-label">
                  <strong>Viewer</strong>
                  <span className="role-option-description">Can view photos</span>
                </span>
              </label>
              <label className="role-option">
                <input
                  type="radio"
                  name="role"
                  value="editor"
                  checked={role === 'editor'}
                  onChange={() => setRole('editor')}
                  disabled={isProcessing}
                />
                <span className="role-option-label">
                  <strong>Editor</strong>
                  <span className="role-option-description">Can view and upload photos</span>
                </span>
              </label>
            </div>
          </div>

          {displayError && (
            <div
              id="invite-error"
              className="form-error"
              role="alert"
              data-testid="invite-error"
            >
              {displayError}
            </div>
          )}

          <div className="dialog-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
              disabled={isInviting}
              data-testid="cancel-invite-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={isProcessing || !foundUser}
              data-testid="submit-invite-button"
            >
              {isInviting ? 'Inviting...' : 'Invite'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
