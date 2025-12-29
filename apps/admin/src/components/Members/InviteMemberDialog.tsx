/**
 * InviteMemberDialog Component
 *
 * Modal dialog for inviting new members to an album.
 * Handles user lookup, role selection, and invite flow.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserPublic } from '../../lib/api-types';
import { Dialog } from '../Shared/Dialog';

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
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  const [localError, setLocalError] = useState<string | null>(null);
  const [foundUser, setFoundUser] = useState<UserPublic | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleLookup = async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setLocalError(t('member.invite.error.lookUpFirst'));
      return;
    }

    setLocalError(null);
    setLookupError(null);
    setFoundUser(null);

    try {
      const user = await lookupUser(trimmedQuery);
      setFoundUser(user);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('member.invite.userNotFound');
      setLookupError(message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!foundUser) {
      setLocalError(t('member.invite.error.lookUpFirst'));
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

  const displayError = localError || lookupError || error;
  const isProcessing = isInviting || isLookingUp;

  const footer = (
    <>
      <button
        type="button"
        className="button-secondary"
        onClick={onClose}
        disabled={isInviting}
        data-testid="cancel-invite-button"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        form="invite-member-form"
        className="button-primary"
        disabled={isProcessing || !foundUser}
        data-testid="submit-invite-button"
      >
        {isInviting ? t('member.invite.inviting') : t('member.invite.submit')}
      </button>
    </>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('member.invite.title')}
      description={t('member.invite.description')}
      footer={footer}
      testId="invite-member-dialog"
      closeOnBackdropClick={!isInviting}
    >
      <form id="invite-member-form" onSubmit={handleSubmit} className="dialog-form">
        <div className="form-group">
          <label htmlFor="user-query" className="form-label">
            {t('member.invite.userIdLabel')}
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
              placeholder={t('member.invite.userIdPlaceholder')}
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
              {isLookingUp ? t('member.invite.looking') : t('member.invite.lookUp')}
            </button>
          </div>
        </div>

        {foundUser && (
          <div className="found-user" data-testid="found-user">
            <span className="found-user-icon">✓</span>
            <div className="found-user-details">
              <span className="found-user-label">{t('member.invite.foundUserLabel')}</span>
              <span className="found-user-id">{foundUser.id.slice(0, 16)}...</span>
            </div>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">{t('member.invite.roleLabel')}</label>
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
                <strong>{t('member.role.viewer')}</strong>
                <span className="role-option-description">{t('member.invite.viewerDescription')}</span>
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
                <strong>{t('member.role.editor')}</strong>
                <span className="role-option-description">{t('member.invite.editorDescription')}</span>
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
      </form>
    </Dialog>
  );
}
