/**
 * ShareLinksPanel Component
 *
 * Side panel for managing share links of an album.
 * Displays existing share links and allows creating new ones.
 * Only visible to album owners.
 */

import { useState } from 'react';
import { useShareLinks } from '../../hooks/useShareLinks';
import { ShareLinkDialog } from './ShareLinkDialog';
import { ShareLinksList } from './ShareLinksList';

interface ShareLinksPanelProps {
  /** Album ID */
  albumId: string;
  /** Whether the panel is visible */
  isOpen: boolean;
  /** Called when panel should close */
  onClose: () => void;
  /** Whether current user is owner (share links require ownership) */
  isOwner: boolean;
}

/**
 * ShareLinksPanel Component
 *
 * Provides a side panel for:
 * - Viewing existing share links
 * - Creating new share links with configurable access tiers
 * - Revoking share links
 */
export function ShareLinksPanel({
  albumId,
  isOpen,
  onClose,
  isOwner,
}: ShareLinksPanelProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const {
    shareLinks,
    isLoading,
    error,
    refetch,
    createShareLink,
    isCreating,
    createError,
    revokeShareLink,
    isRevoking,
    updateExpiration,
    isUpdating,
    updateError,
  } = useShareLinks(albumId);

  if (!isOpen) {
    return null;
  }

  return (
    <>
      <div
        className="member-panel-backdrop"
        onClick={onClose}
        role="presentation"
        data-testid="share-links-panel-backdrop"
      />
      <aside
        className="member-panel"
        role="complementary"
        aria-label="Share links"
        data-testid="share-links-panel"
      >
        <div className="member-panel-header">
          <h3 className="member-panel-title">Share Links</h3>
          <button
            className="member-panel-close"
            onClick={onClose}
            aria-label="Close share links panel"
            data-testid="close-share-links-button"
          >
            ✕
          </button>
        </div>

        <div className="member-panel-content">
          <ShareLinksList
            shareLinks={shareLinks}
            isLoading={isLoading}
            error={error}
            onRevoke={revokeShareLink}
            isRevoking={isRevoking}
            onCreateClick={() => setShowCreateDialog(true)}
            isOwner={isOwner}
            albumId={albumId}
            onUpdateExpiration={updateExpiration}
            isUpdating={isUpdating}
            updateError={updateError}
            onRefresh={refetch}
          />
        </div>
      </aside>

      <ShareLinkDialog
        isOpen={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreate={createShareLink}
        isCreating={isCreating}
        error={createError}
      />
    </>
  );
}
