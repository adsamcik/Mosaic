import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell } from './components/App/AppShell';
import { LoginForm } from './components/Auth/LoginForm';
import { SharedAlbumViewer } from './components/Shared/SharedAlbumViewer';
import { ToastContainer } from './components/Toast';
import { ToastProvider } from './contexts/ToastContext';
import { useTheme } from './hooks';
import type { User } from './lib/api-types';
import { session } from './lib/session';
import './styles/globals.css';

/**
 * Check if the browser supports required crypto APIs.
 * crypto.subtle requires a secure context (HTTPS or localhost).
 */
function checkCryptoSupport(): { supported: boolean; reason?: string } {
  if (typeof crypto === 'undefined') {
    return { supported: false, reason: 'crypto API is not available' };
  }
  if (typeof crypto.subtle === 'undefined') {
    if (!window.isSecureContext) {
      return {
        supported: false,
        reason: `crypto.subtle requires a secure context. Current URL (${window.location.origin}) is not secure. Use HTTPS or localhost.`,
      };
    }
    return { supported: false, reason: 'crypto.subtle is not available' };
  }
  return { supported: true };
}

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
  const { t } = useTranslation();
  const [isLoggedIn, setIsLoggedIn] = useState(session.isLoggedIn);
  const [isShareLink, setIsShareLink] = useState(isShareLinkRoute);
  const [shareLinkId, setShareLinkId] = useState<string | null>(getShareLinkId);
  // Session restore state
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [pendingSessionUser, setPendingSessionUser] = useState<User | null>(
    null,
  );
  // Crypto support state
  const [cryptoError, setCryptoError] = useState<string | null>(null);

  // Apply theme to document
  useTheme();

  // Check crypto support on mount (before any crypto operations)
  useEffect(() => {
    const cryptoCheck = checkCryptoSupport();
    if (!cryptoCheck.supported) {
      console.error('[App] Crypto not supported:', cryptoCheck.reason);
      setCryptoError(cryptoCheck.reason || 'Crypto APIs not available');
      setIsCheckingSession(false);
    }
  }, []);

  // Check for existing session on mount (handles page reload)
  useEffect(() => {
    // Skip session check for share links
    if (isShareLinkRoute()) {
      setIsCheckingSession(false);
      return;
    }

    // Skip if crypto is not available (will show error)
    if (cryptoError !== null) {
      setIsCheckingSession(false);
      return;
    }

    // Helper to safely check session with error handling
    const checkSessionSafely = async () => {
      try {
        const user = await session.checkSession();
        if (user) {
          setPendingSessionUser(user);
        }
      } catch (err) {
        // Session check failed - proceed to login form
        console.debug('Session check failed:', err);
      } finally {
        setIsCheckingSession(false);
      }
    };

    // Check if we have a session state marker (page was reloaded while logged in)
    if (!session.isLoggedIn && session.needsSessionRestore) {
      // First, try to restore from cache (no password needed)
      if (session.canRestoreFromCache) {
        session
          .restoreFromCache()
          .then((success) => {
            if (success) {
              // Session restored from cache, no password needed!
              setIsCheckingSession(false);
            } else {
              // Cache restore failed, fall back to password restore
              checkSessionSafely();
            }
          })
          .catch((err) => {
            // Cache restore threw an error - proceed to login
            console.debug('Cache restore failed:', err);
            setIsCheckingSession(false);
          });
      } else {
        // No cache available, check if backend session is still valid
        checkSessionSafely();
      }
    } else {
      setIsCheckingSession(false);
    }
  }, [cryptoError]);

  useEffect(() => {
    // Subscribe to session state changes
    return session.subscribe(() => {
      setIsLoggedIn(session.isLoggedIn);
      // Clear pending session when logged in
      if (session.isLoggedIn) {
        setPendingSessionUser(null);
      }
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

  // Crypto error - show error message instead of app
  if (cryptoError) {
    return (
      <ToastProvider>
        <div className="login-container" data-testid="crypto-error">
          <div className="login-card">
          <h1
            className="login-title"
            style={{ color: 'var(--color-error, #dc2626)' }}
          >
            {t('errors.cryptoNotSupported', 'Crypto Not Supported')}
          </h1>
          <p className="login-subtitle" style={{ marginBottom: '1rem' }}>
            {t(
              'errors.cryptoNotSupportedMessage',
              'This application requires a secure context (HTTPS or localhost) to function.',
            )}
          </p>
          <details style={{ textAlign: 'left', fontSize: '0.875rem' }}>
            <summary style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>
              {t('errors.technicalDetails', 'Technical Details')}
            </summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                background: 'var(--color-surface, #f5f5f5)',
                padding: '0.5rem',
                borderRadius: '4px',
              }}
            >
              {cryptoError}
            </pre>
          </details>
        </div>
        <ToastContainer />
      </div>
      </ToastProvider>
    );
  }

  // Share link route - no authentication required
  if (isShareLink && shareLinkId) {
    return (
      <ToastProvider>
        <SharedAlbumViewer linkId={shareLinkId} />
        <ToastContainer />
      </ToastProvider>
    );
  }

  // Show loading state while checking session
  if (isCheckingSession) {
    return (
      <ToastProvider>
        <div className="login-container" data-testid="session-check">
          <div className="login-card">
            <h1 className="login-title">{t('common.appName')}</h1>
            <p className="login-subtitle">{t('auth.checkingSession')}</p>
          </div>
        </div>
        <ToastContainer />
      </ToastProvider>
    );
  }

  // Standard authenticated routes
  return (
    <ToastProvider>
      {!isLoggedIn ? (
        <LoginForm pendingSessionUser={pendingSessionUser} />
      ) : (
        <AppShell />
      )}
      <ToastContainer />
    </ToastProvider>
  );
}
