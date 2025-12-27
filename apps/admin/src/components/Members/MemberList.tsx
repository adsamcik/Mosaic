/**
 * MemberList Component
 *
 * Displays list of album members with roles and management actions.
 * Owner can invite new members and remove existing ones.
 */

import { useState } from 'react';
import { useMemberManagement, type MemberInfo } from '../../hooks/useMemberManagement';
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
 * - Remove buttons (for owner)
 */
export function MemberList({ albumId, isOpen, onClose }: MemberListProps) {
  const {
    members,
    isLoading,
    error,
    inviteMember,
    isInviting,
    inviteError,
    removeMember,
    isRemoving,
    lookupUser,
    isLookingUp,
    isOwner,
  } = useMemberManagement(albumId);

  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  const handleRemove = async (member: MemberInfo) => {
    if (!confirm(`Remove ${member.displayName} from this album?`)) {
      return;
    }

    setRemovingUserId(member.userId);
    try {
      await removeMember(member.userId);
    } catch {
      // Error is shown via UI
    } finally {
      setRemovingUserId(null);
    }
  };

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
                        onClick={() => handleRemove(member)}
                        disabled={isRemoving && removingUserId === member.userId}
                        aria-label={`Remove ${member.displayName}`}
                        data-testid={`remove-member-${member.userId}`}
                      >
                        {isRemoving && removingUserId === member.userId
                          ? 'Removing...'
                          : 'Remove'}
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
