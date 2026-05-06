import type { LinkDecryptionKey } from '../../workers/types';
/**
 * Shared Album Viewer Component
 *
 * Main page component for anonymous share link viewers.
 * URL format: /s/{linkId}#k={linkSecret}
 *
 * The fragment (#k=...) is never sent to the server.
 * Visitor imports link-tier handles from the URL fragment seed and server-wrapped keys.
 */

import { useEffect, useMemo, useState } from 'react';
import '../../../src/styles/globals.css';
import { parseLinkFragment, useLinkKeys } from '../../hooks/useLinkKeys';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import { decryptAlbumNameWithTierKey } from '../../lib/album-metadata-service';
import { createLogger } from '../../lib/logger';
import '../../styles/shared-album.css';
import { SharedGallery } from './SharedGallery';

const log = createLogger('SharedAlbumViewer');

interface SharedAlbumViewerProps {
  /** Link ID from URL path */
  linkId: string;
}

/**
 * Parse the current URL to extract linkId and linkSecret
 */
function useShareLinkParams(): {
  linkId: string | null;
  linkSecret: string | null;
} {
  const [params, setParams] = useState<{
    linkId: string | null;
    linkSecret: string | null;
  }>({
    linkId: null,
    linkSecret: null,
  });

  useEffect(() => {
    // Extract linkId from path: /s/{linkId}
    const pathMatch = window.location.pathname.match(/\/s\/([A-Za-z0-9_-]+)$/);
    const linkId = pathMatch?.[1] ?? null;

    // Extract linkSecret from fragment: #k={linkSecret}
    const linkSecret = parseLinkFragment(window.location.hash);

    setParams({ linkId, linkSecret });

    // Listen for hash changes (in case user modifies fragment)
    const handleHashChange = () => {
      const newSecret = parseLinkFragment(window.location.hash);
      setParams((prev) => ({ ...prev, linkSecret: newSecret }));
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return params;
}

/**
 * Access tier display names
 */
function getAccessTierName(tier: 1 | 2 | 3): string {
  switch (tier) {
    case 1:
      return 'Thumbnails Only';
    case 2:
      return 'Preview';
    case 3:
      return 'Full Access';
  }
}

/**
 * Shared Album Viewer
 * Main entry point for anonymous share link access
 */
export function SharedAlbumViewer({
  linkId: propLinkId,
}: SharedAlbumViewerProps) {
  // Parse URL params (use prop if provided, otherwise parse from URL)
  const urlParams = useShareLinkParams();
  const linkId = propLinkId || urlParams.linkId;
  const linkSecret = urlParams.linkSecret;

  // Load and manage link keys
  const {
    isLoading,
    error,
    albumId,
    accessTier,
    tierKeys,
    encryptedName,
    grantToken,
    isValid,
  } = useLinkKeys(linkId, linkSecret);

  // Memoize tier keys map to prevent unnecessary re-renders
  const tierKeysMap = useMemo(() => tierKeys, [tierKeys]);

  // Decrypt album name
  const [albumName, setAlbumName] = useState<string | null>(null);

  useEffect(() => {
    if (!encryptedName || tierKeys.size === 0) {
      setAlbumName(null);
      return;
    }

    let cancelled = false;

    async function decryptName() {
      try {
        log.debug('Attempting to decrypt album name', {
          hasEncryptedName: !!encryptedName,
          encryptedNameLength: encryptedName?.length ?? 0,
          tierKeyCount: tierKeys.size,
          availableEpochs: Array.from(tierKeys.keys()),
        });

        // Get the highest tier key from any epoch
        // In share link context, these are already unwrapped tier keys (not epoch seeds)
        let tierKey: LinkDecryptionKey | undefined;
        let usedTier: AccessTierType | undefined;
        let usedEpoch: number | undefined;

        for (const [epochId, epochTiers] of tierKeys) {
          for (const tier of [3, 2, 1] as AccessTierType[]) {
            const key = epochTiers.get(tier);
            if (key) {
              tierKey = key.linkTierHandleId;
              usedTier = tier;
              usedEpoch = epochId;
              break;
            }
          }
          if (tierKey) break;
        }

        if (!tierKey) {
          log.warn('No tier key found for album name decryption');
          return;
        }

        log.debug('Using tier key for album name', {
          epochId: usedEpoch,
          tier: usedTier,
        });

        // Use decryptAlbumNameWithTierKey for share links since we have
        // the tier key directly (not an epochSeed that needs derivation)
        const name = await decryptAlbumNameWithTierKey(
          encryptedName!,
          tierKey,
          albumId ?? 'shared',
        );

        log.info('Album name decrypted successfully', { name });

        if (!cancelled) {
          setAlbumName(name);
        }
      } catch (err) {
        // Failed to decrypt - album name stays null (shows "Shared Album")
        log.error('Failed to decrypt album name', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    decryptName();

    return () => {
      cancelled = true;
    };
  }, [encryptedName, tierKeys, albumId]);

  // Missing secret error
  if (!linkSecret) {
    return (
      <div className="shared-viewer" data-testid="shared-album-viewer">
        <div className="shared-viewer-container">
          <div className="shared-viewer-error">
            <span className="error-icon">🔗</span>
            <h2>Invalid Share Link</h2>
            <p>
              This link appears to be incomplete. The secret key is missing from
              the URL.
            </p>
            <p className="error-hint">
              Share links should end with <code>#k=...</code>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="shared-viewer" data-testid="shared-album-viewer">
        <div className="shared-viewer-container">
          <div className="shared-viewer-loading">
            <div className="loading-spinner loading-spinner-large" />
            <p>Validating share link...</p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !isValid) {
    return (
      <div className="shared-viewer" data-testid="shared-album-viewer">
        <div className="shared-viewer-container">
          <div className="shared-viewer-error">
            <span className="error-icon">⚠️</span>
            <h2>Unable to Access Album</h2>
            <p>
              {error?.message || 'This share link is invalid or has expired.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Valid link - show gallery
  return (
    <div className="shared-viewer" data-testid="shared-album-viewer">
      <header className="shared-viewer-header">
        <div className="header-left">
          <h1 className="app-title">
            {albumName ? `🖼️ ${albumName}` : '🖼️ Mosaic'}
          </h1>
          <span className="shared-badge">Shared Album</span>
        </div>
        <div className="header-right">
          {accessTier && (
            <span className="access-tier-badge" title="Access level">
              {getAccessTierName(accessTier)}
            </span>
          )}
        </div>
      </header>

      <main className="shared-viewer-main">
        {albumId && accessTier && (
          <SharedGallery
            linkId={linkId!}
            albumId={albumId}
            accessTier={accessTier}
            grantToken={grantToken}
            tierKeys={tierKeysMap}
            isLoadingKeys={isLoading}
          />
        )}
      </main>

      <footer className="shared-viewer-footer">
        <p>
          Powered by <strong>Mosaic</strong> — Zero-knowledge encrypted photo
          gallery
        </p>
      </footer>
    </div>
  );
}

export default SharedAlbumViewer;
