/**
 * ShareLinksPanel Component
 *
 * Side panel for managing share links of an album.
 * Displays existing share links and allows creating/editing them.
 * Only visible to album owners.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShareLinkInfo } from '../../hooks/useShareLinks';
import { useShareLinks } from '../../hooks/useShareLinks';
import { EditShareLinkView } from './EditLinkExpirationDialog'; // Rename file eventually?
import { CreateShareLinkView } from './ShareLinkDialog'; // Rename file eventually?
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

type PanelView = 'list' | 'create' | 'edit';

/**
 * ShareLinksPanel Component
 */
export function ShareLinksPanel({
  albumId,
  isOpen,
  onClose,
  isOwner,
}: ShareLinksPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<PanelView>('list');
  const [editingLink, setEditingLink] = useState<ShareLinkInfo | null>(null);

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

  // Reset view when closing
  if (!isOpen && view !== 'list') {
    setView('list');
    setEditingLink(null);
  }

  if (!isOpen) {
    return null;
  }

  const handleBack = () => {
    setView('list');
    setEditingLink(null);
  };

  const handleDoneCreation = () => {
    setView('list');
    refetch();
  };

  const handleCreateClick = () => {
    setView('create');
  };

  const handleEditClick = (link: ShareLinkInfo) => {
    setEditingLink(link);
    setView('edit');
  };

  const handleSaveEdit = () => {
    setView('list');
    setEditingLink(null);
    refetch();
  };

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
          {view !== 'list' ? (
            <button
              type="button"
              className="panel-back-button"
              onClick={handleBack}
              aria-label={t('shareLink.panel.backToList')}
              data-testid="panel-back-button"
            >
              ←
            </button>
          ) : null}
          
          <h3 className="member-panel-title">
            {view === 'create'
              ? t('shareLink.panel.createTitle')
              : view === 'edit'
              ? t('shareLink.panel.editTitle')
              : t('shareLink.panel.listTitle')}
          </h3>
          
          <button
            className="member-panel-close"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="close-share-links-button"
          >
            ✕
          </button>
        </div>

        <div className="member-panel-content">
          {view === 'list' && (
            <ShareLinksList
              shareLinks={shareLinks}
              isLoading={isLoading}
              error={error}
              onRevoke={revokeShareLink}
              isRevoking={isRevoking}
              onCreateClick={handleCreateClick}
              onEditClick={handleEditClick}
              isOwner={isOwner}
              onUpdateExpiration={updateExpiration}
              isUpdating={isUpdating}
              updateError={updateError}
              onRefresh={refetch}
            />
          )}

          {view === 'create' && (
            <CreateShareLinkView
              onCancel={handleBack}
              onDone={handleDoneCreation}
              onCreate={createShareLink}
              isCreating={isCreating}
              error={createError}
            />
          )}

          {view === 'edit' && editingLink && (
            <EditShareLinkView
              link={editingLink}
              albumId={albumId}
              onCancel={handleBack}
              onSave={handleSaveEdit}
              onUpdate={updateExpiration}
              isUpdating={isUpdating}
              error={updateError}
            />
          )}
        </div>
      </aside>
    </>
  );
}
