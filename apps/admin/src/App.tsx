import { useEffect, useState } from 'react';
import { session } from './lib/session';
import { LoginForm } from './components/Auth/LoginForm';
import { AppShell } from './components/App/AppShell';
import { SharedAlbumViewer } from './components/Shared/SharedAlbumViewer';
import './styles/globals.css';

/**
 * Check if the current URL is a share link route
 * Share links have format: /s/{linkId}#k={linkSecret}
 */
function isShareLinkRoute(): boolean {
  return /^\/s\/[A-Za-z0-9_-]+$/.test(window.location.pathname);
}

/**
 * Extract linkId from share link URL path
 */
function getShareLinkId(): string | null {
  const match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? null;
}

/**
 * Root Application Component
 * Manages authentication state and renders appropriate view
 *
 * Routes:
 * - /s/{linkId}#k={secret} -> SharedAlbumViewer (anonymous, no auth required)
 * - /* -> LoginForm or AppShell (authenticated)
 */
export function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(session.isLoggedIn);
  const [isShareLink, setIsShareLink] = useState(isShareLinkRoute);
  const [shareLinkId, setShareLinkId] = useState<string | null>(getShareLinkId);

  useEffect(() => {
    // Subscribe to session state changes
    return session.subscribe(() => {
      setIsLoggedIn(session.isLoggedIn);
    });
  }, []);

  // Handle browser navigation (popstate)
  useEffect(() => {
    const handlePopState = () => {
      setIsShareLink(isShareLinkRoute());
      setShareLinkId(getShareLinkId());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Share link route - no authentication required
  if (isShareLink && shareLinkId) {
    return <SharedAlbumViewer linkId={shareLinkId} />;
  }

  // Standard authenticated routes
  if (!isLoggedIn) {
    return <LoginForm />;
  }

  return <AppShell />;
}
