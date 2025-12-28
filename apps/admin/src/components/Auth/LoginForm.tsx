import { useState, useEffect } from 'react';
import { session } from '../../lib/session';
import { isLocalAuthMode } from '../../lib/local-auth';
import type { User } from '../../lib/api-types';

interface LoginFormProps {
  /** User from a pending session that needs password to restore crypto state */
  pendingSessionUser?: User | null;
}

/**
 * Login Form Component
 * Handles password entry and session initialization.
 * In development mode, shows username field and uses simplified dev-auth.
 * When pendingSessionUser is provided, shows session restore mode.
 */
export function LoginForm({ pendingSessionUser }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isLocalAuth, setIsLocalAuth] = useState(false);
  const [checkingAuthMode, setCheckingAuthMode] = useState(true);

  // Whether we're restoring an existing session (page reload case)
  const isSessionRestore = !!pendingSessionUser;

  // Check if LocalAuth mode is available on mount
  useEffect(() => {
    isLocalAuthMode().then((localAuth) => {
      setIsLocalAuth(localAuth);
      setCheckingAuthMode(false);
      if (localAuth) {
        // Default username for local auth
        setUsername('dev');
      }
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Session restore mode: just need password
    if (isSessionRestore) {
      if (!password.trim()) {
        setError('Please enter your password');
        return;
      }
    } else if (isLocalAuth) {
      // LocalAuth mode: username required, password used for local crypto
      if (!username.trim()) {
        setError('Please enter a username');
        return;
      }
      if (!password.trim()) {
        setError('Please enter a password');
        return;
      }
    } else {
      // ProxyAuth mode: only password required
      if (!password.trim()) {
        setError('Please enter a password');
        return;
      }
    }

    setLoading(true);
    setError('');

    try {
      if (isSessionRestore) {
        // Restore session with password (page reload case)
        await session.restoreSession(password, pendingSessionUser);
      } else if (isLocalAuth) {
        await session.localLogin(username, password);
      } else {
        await session.login(password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuthMode) {
    return (
      <div className="login-container" data-testid="login-form">
        <div className="login-card">
          <h1 className="login-title">🖼️ Mosaic</h1>
          <p className="login-subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container" data-testid="login-form">
      <div className="login-card">
        <h1 className="login-title">🖼️ Mosaic</h1>
        {isSessionRestore ? (
          <p className="login-subtitle">Welcome back! Enter your password to continue.</p>
        ) : (
          <p className="login-subtitle">Zero-knowledge encrypted photo gallery</p>
        )}

        {isSessionRestore && (
          <div className="session-restore-badge" data-testid="session-restore-badge">
            🔄 Session Restore
          </div>
        )}

        {isLocalAuth && !isSessionRestore && (
          <div className="dev-mode-badge" data-testid="local-auth-badge">
            🔐 Local Authentication
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          {isLocalAuth && !isSessionRestore && (
            <div className="form-group">
              <label htmlFor="username" className="form-label">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                disabled={loading}
                className="form-input"
                autoComplete="username"
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              disabled={loading}
              className="form-input"
              autoFocus
            />
          </div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="login-button"
          >
            {loading ? 'Unlocking...' : 'Unlock'}
          </button>
        </form>

        <p className="login-note">
          {isSessionRestore
            ? 'Your session is still active. Enter your password to unlock encryption.'
            : isLocalAuth
              ? 'Local authentication mode. User will be created if it does not exist.'
              : 'Your photos are encrypted locally. The server never sees your data.'}
        </p>
      </div>
    </div>
  );
}
