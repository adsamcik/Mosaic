/**
 * ShareLinksList Component
 *
 * Displays existing share links for an album with options to copy or revoke.
 */

import { useState } from 'react';
import type { ShareLinkInfo } from '../hooks/useShareLinks';

interface ShareLinksListProps {
  /** List of share links */
  shareLinks: ShareLinkInfo[];
  /** Whether links are loading */
  isLoading: boolean;
  /** Error loading links */
  error: Error | null;
  /** Called to revoke a link */
  onRevoke: (linkId: string) => Promise<void>;
  /** Whether revoke is in progress */
  isRevoking: boolean;
  /** Called to create a new link */
  onCreateClick: () => void;
  /** Whether current user is owner */
  isOwner: boolean;
}

/**
 * ShareLinksList Component
 *
 * Shows a list of existing share links with:
 * - Access tier badge
 * - Use count / max uses
 * - Expiry date
 * - Copy link button
 * - Revoke button with confirmation
 */
export function ShareLinksList({
  shareLinks,
  isLoading,
  error,
  onRevoke,
  isRevoking,
  onCreateClick,
  isOwner,
}: ShareLinksListProps) {
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyLink = async (link: ShareLinkInfo) => {
    // Build the share URL from linkId
    // Note: We can't fully reconstruct the URL without the secret,
    // so we just copy the link ID for reference
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/s/${link.linkId}`;

    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard access might be denied
      console.error('Failed to copy to clipboard');
    }
  };

  const handleRevokeClick = (linkId: string) => {
    setConfirmRevokeId(linkId);
  };

  const handleConfirmRevoke = async () => {
    if (!confirmRevokeId) return;

    try {
      await onRevoke(confirmRevokeId);
      setConfirmRevokeId(null);
    } catch {
      // Error handled by parent
    }
  };

  const handleCancelRevoke = () => {
    setConfirmRevokeId(null);
  };

  // Filter out revoked links for display (or show them differently)
  const activeLinks = shareLinks.filter((link) => !link.isRevoked);
  const revokedLinks = shareLinks.filter((link) => link.isRevoked);

  if (isLoading) {
    return (
      <div className="share-links-list" data-testid="share-links-list">
        <div className="share-links-loading" data-testid="share-links-loading">
          Loading share links...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="share-links-list" data-testid="share-links-list">
        <div className="share-links-error" data-testid="share-links-error">
          Failed to load share links: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="share-links-list" data-testid="share-links-list">
      <div className="share-links-header">
        <h3 className="share-links-title">Share Links</h3>
        {isOwner && (
          <button
            type="button"
            className="button-primary"
            onClick={onCreateClick}
            data-testid="create-share-link-button"
          >
            + New Link
          </button>
        )}
      </div>

      {activeLinks.length === 0 && revokedLinks.length === 0 ? (
        <div className="share-links-empty" data-testid="share-links-empty">
          <p>No share links yet.</p>
          {isOwner && (
            <p>Create a share link to let others view this album.</p>
          )}
        </div>
      ) : (
        <>
          {activeLinks.length > 0 && (
            <ul className="share-links-items" data-testid="active-share-links">
              {activeLinks.map((link) => (
                <li
                  key={link.id}
                  className={`share-link-item ${link.isExpired ? 'expired' : ''}`}
                  data-testid="share-link-item"
                >
                  <div className="share-link-info">
                    <div className="share-link-tier">
                      <span
                        className={`tier-badge tier-${link.accessTier}`}
                        data-testid="tier-badge"
                      >
                        {link.accessTierDisplay}
                      </span>
                      {link.isExpired && (
                        <span className="expired-badge" data-testid="expired-badge">
                          Expired
                        </span>
                      )}
                    </div>
                    <div className="share-link-stats">
                      <span className="stat" data-testid="use-count">
                        {link.useCount} uses
                        {link.maxUses !== undefined && ` / ${link.maxUses} max`}
                      </span>
                      {link.expiryDisplay && (
                        <span className="stat" data-testid="expiry-date">
                          Expires: {link.expiryDisplay}
                        </span>
                      )}
                      <span className="stat" data-testid="created-date">
                        Created:{' '}
                        {new Date(link.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>
                  <div className="share-link-actions">
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => handleCopyLink(link)}
                      title="Copy link ID (note: does not include secret)"
                      data-testid="copy-link-button"
                    >
                      {copiedId === link.id ? '✓ Copied' : 'Copy ID'}
                    </button>
                    {isOwner && (
                      <button
                        type="button"
                        className="button-danger button-small"
                        onClick={() => handleRevokeClick(link.id)}
                        disabled={isRevoking}
                        data-testid="revoke-link-button"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {revokedLinks.length > 0 && (
            <details className="revoked-links-section" data-testid="revoked-links-section">
              <summary className="revoked-links-summary">
                Revoked Links ({revokedLinks.length})
              </summary>
              <ul className="share-links-items revoked" data-testid="revoked-share-links">
                {revokedLinks.map((link) => (
                  <li
                    key={link.id}
                    className="share-link-item revoked"
                    data-testid="revoked-link-item"
                  >
                    <div className="share-link-info">
                      <div className="share-link-tier">
                        <span className={`tier-badge tier-${link.accessTier} revoked`}>
                          {link.accessTierDisplay}
                        </span>
                        <span className="revoked-badge">Revoked</span>
                      </div>
                      <div className="share-link-stats">
                        <span className="stat">
                          {link.useCount} uses before revocation
                        </span>
                        <span className="stat">
                          Created:{' '}
                          {new Date(link.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {/* Revoke Confirmation Modal */}
      {confirmRevokeId && (
        <div
          className="dialog-backdrop"
          onClick={handleCancelRevoke}
          role="presentation"
          data-testid="revoke-confirm-backdrop"
        >
          <dialog
            className="dialog confirm-dialog"
            open
            aria-labelledby="revoke-confirm-title"
            aria-modal="true"
            data-testid="revoke-confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="revoke-confirm-title" className="dialog-title">
              Revoke Share Link?
            </h3>
            <p className="dialog-description">
              This will permanently disable this share link. Anyone with the link will
              no longer be able to access the album.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={handleCancelRevoke}
                disabled={isRevoking}
                data-testid="cancel-revoke-button"
              >
                Cancel
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={handleConfirmRevoke}
                disabled={isRevoking}
                data-testid="confirm-revoke-button"
              >
                {isRevoking ? 'Revoking...' : 'Revoke Link'}
              </button>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
}
