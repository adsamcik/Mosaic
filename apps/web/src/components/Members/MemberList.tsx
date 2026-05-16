/**
 * MemberList Component
 *
 * Displays list of album members with roles and management actions.
 * Owner can invite new members and remove existing ones.
 * Member removal triggers epoch key rotation for security.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useMemberManagement,
  type MemberInfo,
  type RemovalProgressStep,
} from '../../hooks/useMemberManagement';
import { useRosterVerification } from '../../hooks/useRosterVerification';
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
 * Get translation key for removal progress step
 */
function getProgressKey(step: RemovalProgressStep): string {
  switch (step) {
    case 'removing':
      return 'member.progress.inviting';
    case 'rotating':
      return 'member.progress.keyRotation';
    case 'clearing':
      return 'member.progress.clearingCaches';
    case 'complete':
      return 'member.progress.done';
    default:
      return 'common.processing';
  }
}

/**
 * Get translation key for role
 */
function getRoleKey(role: string): string {
  switch (role) {
    case 'owner':
      return 'member.role.owner';
    case 'editor':
      return 'member.role.editor';
    case 'viewer':
      return 'member.role.viewer';
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
  const { t } = useTranslation();
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

  // C2c-3: gate role badges on owner-signed roster verification. Until
  // the owner publishes a signed roster the UI must NOT claim badges
  // are trusted — a compromised server could otherwise fabricate admin
  // / editor labels (audit `threat-model C-3`).
  const rosterInput = useMemo(
    () => members.map((m) => ({ userId: m.userId, role: m.role })),
    [members],
  );
  const rosterVerification = useRosterVerification(
    isOpen ? albumId : null,
    rosterInput,
    isOpen,
  );
  const rosterVerified = rosterVerification.status?.verified === true;
  const rosterUnverifiedReason = rosterVerification.status?.verified === false
    ? rosterVerification.status.reason
    : null;

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
      const message =
        err instanceof Error ? err.message : 'Failed to remove member';
      setRemoveError(message);
    }
  }, [memberToRemove, removeMemberWithRotation]);

  const handleCancelRemove = useCallback(() => {
    if (isRemoving) return; // Prevent cancel during removal
    setShowRemoveDialog(false);
    setMemberToRemove(null);
    setRemoveError(null);
  }, [isRemoving]);

  const handleInvite = async (
    recipientId: string,
    role: 'editor' | 'viewer',
  ) => {
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
          <h3 className="member-panel-title">{t('member.title')}</h3>
          <button
            className="member-panel-close"
            onClick={onClose}
            aria-label={t('member.closePanel')}
            data-testid="close-members-button"
          >
            ✕
          </button>
        </div>

        <div className="member-panel-content">
          {isLoading && (
            <div className="member-list-loading" data-testid="members-loading">
              <div className="loading-spinner" />
              <span>{t('member.loading')}</span>
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
              {/* C2c-3: surface signed-roster trust state so users can
                  see when role badges are trustworthy vs. provisional.
                  An unverified roster is NOT a hard failure — the
                  members list is still shown so the user can act on it
                  — but the badge styling is muted and the reason is
                  surfaced for transparency. */}
              {rosterUnverifiedReason && (
                <div
                  className="member-roster-unverified"
                  role="status"
                  data-testid="roster-unverified"
                  data-roster-reason={rosterUnverifiedReason}
                >
                  <span className="error-icon" aria-hidden="true">
                    🛈
                  </span>
                  <span>
                    {t('member.rosterUnverified', {
                      defaultValue:
                        'Role badges below are unverified ({{reason}}). The owner has not published a signed roster, or the signature does not match. Treat them as provisional.',
                      reason: rosterUnverifiedReason,
                    })}
                  </span>
                </div>
              )}

              {isOwner && (
                <button
                  className="button-primary invite-button"
                  onClick={() => setShowInviteDialog(true)}
                  data-testid="invite-button"
                >
                  <span className="button-icon">+</span>
                  {t('member.inviteMember')}
                </button>
              )}

              <ul className="member-list" data-testid="member-list">
                {members.map((member) => (
                  <li
                    key={member.userId}
                    className="member-item"
                    data-testid="member-item"
                  >
                    <div className="member-info">
                      <span className="member-avatar">👤</span>
                      <div className="member-details">
                        <span className="member-name">
                          {member.displayName}
                        </span>
                        <span
                          className={
                            getRoleBadgeClass(member.role) +
                            (rosterVerified ? '' : ' member-role-unverified')
                          }
                          data-testid="member-role-badge"
                          data-role-verified={rosterVerified ? 'true' : 'false'}
                          title={
                            rosterVerified
                              ? undefined
                              : t('member.rolesUnverifiedTitle', {
                                  defaultValue:
                                    'Role unverified: owner has not signed a roster matching this list.',
                                })
                          }
                        >
                          {t(getRoleKey(member.role))}
                        </span>
                      </div>
                    </div>
                    {isOwner && member.role !== 'owner' && (
                      <button
                        className="button-secondary button-small remove-button"
                        onClick={() => handleRemoveClick(member)}
                        disabled={isRemoving}
                        aria-label={t('member.remove')}
                        data-testid={`remove-member-${member.userId}`}
                      >
                        {t('member.remove')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {members.length === 0 && (
                <div className="member-list-empty" data-testid="members-empty">
                  <span>{t('member.noMembers')}</span>
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
              {t('member.removeDialog.title')}
            </h2>

            <div className="dialog-content">
              <p>
                {t('member.removeDialog.confirm', {
                  name: memberToRemove.displayName,
                })}
              </p>
              <p className="dialog-warning">
                {t('member.removeDialog.warning')}
              </p>

              {isRemoving && removalStep && (
                <div
                  className="removal-progress"
                  data-testid="removal-progress"
                >
                  <div className="loading-spinner" />
                  <span>{t(getProgressKey(removalStep))}</span>
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
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={handleConfirmRemove}
                disabled={isRemoving}
                data-testid="confirm-remove-button"
              >
                {isRemoving
                  ? t('member.removeDialog.removing')
                  : t('member.removeDialog.submit')}
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
