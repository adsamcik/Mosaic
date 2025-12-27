/**
 * MemberList Component
 *
 * Displays list of album members with roles and management actions.
 * Owner can invite new members and remove existing ones.
 * Member removal triggers epoch key rotation for security.
 */

import { useState, useCallback } from 'react';
import {
  useMemberManagement,
  type MemberInfo,
  type RemovalProgressStep,
} from '../../hooks/useMemberManagement';
import { InviteMemberDialog } from './InviteMemberDialog';

interface MemberListProps {
  /** Album ID */
  albumId: string;
  /** Whether the panel is visible */
  isOpen: boolean;
  /** Called when panel should close */
  onClose: () => void;
}

/**
 * Get display label for removal progress step
 */
function getProgressLabel(step: RemovalProgressStep): string {
  switch (step) {
    case 'removing':
      return 'Removing member...';
    case 'rotating':
      return 'Rotating keys...';
    case 'clearing':
      return 'Clearing caches...';
    case 'complete':
      return 'Done!';
    default:
      return 'Processing...';
  }
}

/**
 * Get display label for role
 */
function getRoleLabel(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'editor':
      return 'Editor';
    case 'viewer':
      return 'Viewer';
    default:
      return role;
  }
}

/**
 * Get role badge class
 */
function getRoleBadgeClass(role: string): string {
  switch (role) {
    case 'owner':
      return 'member-role member-role-owner';
    case 'editor':
      return 'member-role member-role-editor';
    case 'viewer':
      return 'member-role member-role-viewer';
    default:
      return 'member-role';
  }
}

/**
 * MemberList Component
 *
 * Displays album members in a side panel with:
 * - Member list with roles
 * - Invite button (for owner)
 * - Remove buttons (for owner) with confirmation and key rotation
 */
export function MemberList({ albumId, isOpen, onClose }: MemberListProps) {
  const {
    members,
    isLoading,
    error,
    inviteMember,
    isInviting,
    inviteError,
    removeMemberWithRotation,
    isRemoving,
    removalStep,
    lookupUser,
    isLookingUp,
    isOwner,
  } = useMemberManagement(albumId);

  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<MemberInfo | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleRemoveClick = useCallback((member: MemberInfo) => {
    setMemberToRemove(member);
    setRemoveError(null);
    setShowRemoveDialog(true);
  }, []);

  const handleConfirmRemove = useCallback(async () => {
    if (!memberToRemove) return;

    try {
      await removeMemberWithRotation(memberToRemove.userId);
      setShowRemoveDialog(false);
      setMemberToRemove(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove member';
      setRemoveError(message);
    }
  }, [memberToRemove, removeMemberWithRotation]);

  const handleCancelRemove = useCallback(() => {
    if (isRemoving) return; // Prevent cancel during removal
    setShowRemoveDialog(false);
    setMemberToRemove(null);
    setRemoveError(null);
  }, [isRemoving]);

  const handleInvite = async (recipientId: string, role: 'editor' | 'viewer') => {
    await inviteMember(recipientId, role);
    setShowInviteDialog(false);
  };

  if (!isOpen) {
    return null;
  }

  return (
    <>
      <div
        className="member-panel-backdrop"
        onClick={onClose}
        role="presentation"
        data-testid="member-panel-backdrop"
      />
      <aside
        className="member-panel"
        role="complementary"
        aria-label="Album members"
        data-testid="member-panel"
      >
        <div className="member-panel-header">
          <h3 className="member-panel-title">Members</h3>
          <button
            className="member-panel-close"
            onClick={onClose}
            aria-label="Close members panel"
            data-testid="close-members-button"
          >
            ✕
          </button>
        </div>

        <div className="member-panel-content">
          {isLoading && (
            <div className="member-list-loading" data-testid="members-loading">
              <div className="loading-spinner" />
              <span>Loading members...</span>
            </div>
          )}

          {error && !isLoading && (
            <div className="member-list-error" data-testid="members-error">
              <span className="error-icon">⚠️</span>
              <span>{error.message}</span>
            </div>
          )}

          {!isLoading && !error && (
            <>
              {isOwner && (
                <button
                  className="button-primary invite-button"
                  onClick={() => setShowInviteDialog(true)}
                  data-testid="invite-button"
                >
                  <span className="button-icon">+</span>
                  Invite Member
                </button>
              )}

              <ul className="member-list" data-testid="member-list">
                {members.map((member) => (
                  <li key={member.userId} className="member-item" data-testid="member-item">
                    <div className="member-info">
                      <span className="member-avatar">👤</span>
                      <div className="member-details">
                        <span className="member-name">{member.displayName}</span>
                        <span className={getRoleBadgeClass(member.role)}>
                          {getRoleLabel(member.role)}
                        </span>
                      </div>
                    </div>
                    {isOwner && member.role !== 'owner' && (
                      <button
                        className="button-secondary button-small remove-button"
                        onClick={() => handleRemoveClick(member)}
                        disabled={isRemoving}
                        aria-label={`Remove ${member.displayName}`}
                        data-testid={`remove-member-${member.userId}`}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {members.length === 0 && (
                <div className="member-list-empty" data-testid="members-empty">
                  <span>No members yet</span>
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Remove Member Confirmation Dialog */}
      {showRemoveDialog && memberToRemove && (
        <div
          className="dialog-backdrop"
          onClick={handleCancelRemove}
          role="presentation"
          data-testid="remove-dialog-backdrop"
        >
          <dialog
            className="dialog remove-member-dialog"
            open
            aria-labelledby="remove-member-title"
            aria-modal="true"
            data-testid="remove-member-dialog"
          >
            <h2 id="remove-member-title" className="dialog-title">
              Remove Member
            </h2>

            <div className="dialog-content">
              <p>
                Are you sure you want to remove{' '}
                <strong>{memberToRemove.displayName}</strong> from this album?
              </p>
              <p className="dialog-warning">
                ⚠️ This will rotate the encryption keys. The removed member will
                not be able to access any new photos added after removal.
              </p>

              {isRemoving && removalStep && (
                <div className="removal-progress" data-testid="removal-progress">
                  <div className="loading-spinner" />
                  <span>{getProgressLabel(removalStep)}</span>
                </div>
              )}

              {removeError && (
                <div className="dialog-error" data-testid="remove-error">
                  <span className="error-icon">⚠️</span>
                  <span>{removeError}</span>
                </div>
              )}
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={handleCancelRemove}
                disabled={isRemoving}
                data-testid="cancel-remove-button"
              >
                Cancel
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={handleConfirmRemove}
                disabled={isRemoving}
                data-testid="confirm-remove-button"
              >
                {isRemoving ? 'Removing...' : 'Remove Member'}
              </button>
            </div>
          </dialog>
        </div>
      )}

      <InviteMemberDialog
        isOpen={showInviteDialog}
        onClose={() => setShowInviteDialog(false)}
        onInvite={handleInvite}
        lookupUser={lookupUser}
        isInviting={isInviting}
        isLookingUp={isLookingUp}
        error={inviteError}
      />
    </>
  );
}
