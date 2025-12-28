/**
 * Shared Album Viewer Component
 *
 * Main page component for anonymous share link viewers.
 * URL format: /s/{linkId}#k={linkSecret}
 *
 * The fragment (#k=...) is never sent to the server.
 * Visitor uses linkSecret to derive wrappingKey and unwrap tier keys.
 */

import { useEffect, useMemo, useState } from 'react';
import { useLinkKeys, parseLinkFragment } from '../../hooks/useLinkKeys';
import { SharedGallery } from './SharedGallery';
import '../../../src/styles/globals.css';

interface SharedAlbumViewerProps {
  /** Link ID from URL path */
  linkId: string;
}

/**
 * Parse the current URL to extract linkId and linkSecret
 */
function useShareLinkParams(): { linkId: string | null; linkSecret: string | null } {
  const [params, setParams] = useState<{ linkId: string | null; linkSecret: string | null }>({
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
export function SharedAlbumViewer({ linkId: propLinkId }: SharedAlbumViewerProps) {
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
    isValid,
  } = useLinkKeys(linkId, linkSecret);

  // Memoize tier keys map to prevent unnecessary re-renders
  const tierKeysMap = useMemo(() => tierKeys, [tierKeys]);

  // Missing secret error
  if (!linkSecret) {
    return (
      <div className="shared-viewer" data-testid="shared-album-viewer">
        <div className="shared-viewer-container">
          <div className="shared-viewer-error">
            <span className="error-icon">🔗</span>
            <h2>Invalid Share Link</h2>
            <p>
              This link appears to be incomplete. The secret key is missing from the URL.
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
            <p>{error?.message || 'This share link is invalid or has expired.'}</p>
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
          <h1 className="app-title">🖼️ Mosaic</h1>
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
            tierKeys={tierKeysMap}
            isLoadingKeys={isLoading}
          />
        )}
      </main>

      <footer className="shared-viewer-footer">
        <p>
          Powered by <strong>Mosaic</strong> — Zero-knowledge encrypted photo gallery
        </p>
      </footer>
    </div>
  );
}

export default SharedAlbumViewer;
