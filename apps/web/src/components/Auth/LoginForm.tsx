import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { User } from '../../lib/api-types';
import { checkServerStatus } from '../../lib/local-auth';
import { session } from '../../lib/session';

interface LoginFormProps {
  /** User from a pending session that needs password to restore crypto state */
  pendingSessionUser?: User | null;
}

/**
 * Login Form Component
 * Handles password entry and session initialization.
 * In LocalAuth mode, shows username/password and register option.
 * When pendingSessionUser is provided, shows session restore mode.
 */
export function LoginForm({ pendingSessionUser }: LoginFormProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isLocalAuth, setIsLocalAuth] = useState(false);
  const [isProxyAuth, setIsProxyAuth] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [checkingAuthMode, setCheckingAuthMode] = useState(true);
  const [isServerUnreachable, setIsServerUnreachable] = useState(false);

  // Whether we're restoring an existing session (page reload case)
  const isSessionRestore = !!pendingSessionUser;

  // Show ProxyAuth-only mode when proxy auth is enabled but local auth is not
  // When both are enabled, prefer LocalAuth (user enters username/password)
  const isProxyAuthOnly = isProxyAuth && !isLocalAuth;

  const checkServer = async () => {
    try {
      setLoading(true);
      setError('');
      const status = await checkServerStatus();
      setIsLocalAuth(status.isLocalAuth);
      setIsProxyAuth(status.isProxyAuth);

      if (!status.isOnline) {
        setError(t('auth.error.serverUnreachable'));
        setIsServerUnreachable(true);
      } else if (status.statusCode && status.statusCode >= 500) {
        // Use the detailed error from the server if available, otherwise a friendly message
        const detail = status.error?.startsWith('Server error:')
          ? status.error
          : `System error (${status.statusCode})`;
        setError(t('auth.error.serverUnavailable', { status: detail }));
        setIsServerUnreachable(true);
      } else {
        setIsServerUnreachable(false);
      }
    } finally {
      setLoading(false);
      setCheckingAuthMode(false);
    }
  };

  // Check if LocalAuth mode is available on mount
  useEffect(() => {
    checkServer();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isServerUnreachable) {
      await checkServer();
      return;
    }

    // Session restore mode: just need password
    if (isSessionRestore) {
      if (!password.trim()) {
        setError(t('auth.error.passwordRequired'));
        return;
      }
    } else if (isLocalAuth) {
      // LocalAuth mode: username required, password used for local crypto
      if (!username.trim()) {
        setError(t('auth.error.usernameRequired'));
        return;
      }
      if (!password.trim()) {
        setError(t('auth.error.passwordRequired'));
        return;
      }
      // Registration mode: require password confirmation
      if (isRegisterMode) {
        if (password.length < 8) {
          setError(t('auth.error.passwordTooShort'));
          return;
        }
        if (password !== confirmPassword) {
          setError(t('auth.error.passwordMismatch'));
          return;
        }
      }
    } else if (isProxyAuthOnly) {
      // ProxyAuth-only mode: only password required (username comes from proxy header)
      if (!password.trim()) {
        setError(t('auth.error.passwordRequired'));
        return;
      }
    } else {
      // No auth mode configured - this shouldn't happen
      setError(t('auth.error.noAuthMethod'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (isSessionRestore) {
        // Restore session with password (page reload case)
        await session.restoreSession(password, pendingSessionUser);
      } else if (isLocalAuth) {
        if (isRegisterMode) {
          await session.localRegister(username, password);
        } else {
          await session.localLogin(username, password);
        }
      } else if (isProxyAuthOnly) {
        await session.login(password);
      } else {
        setError(t('auth.error.noAuthAvailable'));
        setLoading(false);
        return;
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Operation failed';
      // Provide helpful error messages
      if (errorMessage.includes('Invalid credentials')) {
        setError(t('auth.error.invalidCredentials'));
      } else if (errorMessage.includes('Username already exists')) {
        setError(t('auth.error.usernameTaken'));
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegisterMode(!isRegisterMode);
    setError('');
    setConfirmPassword('');
  };

  if (checkingAuthMode) {
    return (
      <div className="login-container" data-testid="login-form">
        <div className="login-card">
          <h1 className="login-title">{t('common.appName')}</h1>
          <p className="login-subtitle">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container" data-testid="login-form">
      <div className="login-card">
        <h1 className="login-title">{t('common.appName')}</h1>
        {isSessionRestore ? (
          <p className="login-subtitle">{t('auth.welcomeBack')}</p>
        ) : (
          <p className="login-subtitle">{t('auth.tagline')}</p>
        )}

        {isSessionRestore && (
          <div
            className="session-restore-badge"
            data-testid="session-restore-badge"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginRight: 6 }}
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {t('auth.sessionRestore')}
          </div>
        )}

        {isSessionRestore && (
          <button
            type="button"
            onClick={async () => {
              // Destructive action: require explicit confirmation. The copy
              // must reassure users that server-side photos are unaffected
              // (L4 — see docs/security audit).
              if (!window.confirm(t('auth.clearSessionConfirm'))) {
                return;
              }
              await session.clearCorruptedSession();
              // Force a page reload to reset everything cleanly
              window.location.reload();
            }}
            className="clear-session-button"
            data-testid="clear-session-button"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginRight: 6 }}
            >
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
            {t('auth.clearSession')}
          </button>
        )}

        {isLocalAuth && !isSessionRestore && !isServerUnreachable && (
          <div className="dev-mode-badge" data-testid="local-auth-badge">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginRight: 6 }}
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            {isRegisterMode
              ? t('auth.createAccount')
              : t('auth.localAuthentication')}
          </div>
        )}

        {isProxyAuthOnly && !isSessionRestore && !isServerUnreachable && (
          <div
            className="dev-mode-badge"
            data-testid="proxy-auth-badge"
            style={{
              backgroundColor: 'var(--color-info-bg, #e3f2fd)',
              color: 'var(--color-info, #1976d2)',
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginRight: 6 }}
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            {t('auth.proxyAuthentication')}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          {!isServerUnreachable && (
            <>
              {isLocalAuth && !isSessionRestore && (
                <div className="form-group">
                  <label htmlFor="username" className="form-label">
                    {t('auth.usernameLabel')}
                  </label>
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('auth.usernamePlaceholder')}
                    disabled={loading}
                    className="form-input"
                    autoComplete="username"
                  />
                </div>
              )}

              <div className="form-group">
                <label htmlFor="password" className="form-label">
                  {t('auth.passwordLabel')}
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    isRegisterMode
                      ? t('auth.createPasswordPlaceholder')
                      : t('auth.passwordPlaceholder')
                  }
                  disabled={loading}
                  className="form-input"
                  autoComplete={
                    isRegisterMode ? 'new-password' : 'current-password'
                  }
                  autoFocus
                />
              </div>

              {isLocalAuth && isRegisterMode && !isSessionRestore && (
                <div className="form-group">
                  <label htmlFor="confirmPassword" className="form-label">
                    {t('auth.confirmPasswordLabel')}
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('auth.confirmPasswordPlaceholder')}
                    disabled={loading}
                    className="form-input"
                    autoComplete="new-password"
                  />
                </div>
              )}
            </>
          )}

          {error && (
            <div
              className={`form-error ${isServerUnreachable ? 'server-error' : ''}`}
              role="alert"
            >
              {isServerUnreachable && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ marginRight: 8, flexShrink: 0 }}
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="login-button">
            {loading
              ? isServerUnreachable
                ? t('auth.checkingConnection')
                : isRegisterMode
                  ? t('auth.creatingAccount')
                  : t('auth.signingIn')
              : isServerUnreachable
                ? t('auth.retryConnection')
                : isRegisterMode
                  ? t('auth.createAccountButton')
                  : t('auth.signInButton')}
          </button>
        </form>

        {isLocalAuth && !isSessionRestore && !isServerUnreachable && (
          <button
            type="button"
            onClick={toggleMode}
            className="mode-toggle-button"
            disabled={loading}
          >
            {isRegisterMode
              ? t('auth.haveAccountSignIn')
              : t('auth.noAccountCreate')}
          </button>
        )}

        {!isServerUnreachable && (
          <p className="login-note">
            {isSessionRestore
              ? t('auth.sessionRestoreHelp')
              : isLocalAuth
                ? isRegisterMode
                  ? t('auth.registerHelp')
                  : t('auth.loginHelp')
                : isProxyAuthOnly
                  ? t('auth.proxyAuthHelp')
                  : t('auth.encryptionHelp')}
          </p>
        )}
      </div>
    </div>
  );
}
