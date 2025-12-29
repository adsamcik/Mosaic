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
 * In LocalAuth mode, shows username/password and register option.
 * When pendingSessionUser is provided, shows session restore mode.
 */
export function LoginForm({ pendingSessionUser }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isLocalAuth, setIsLocalAuth] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [checkingAuthMode, setCheckingAuthMode] = useState(true);

  // Whether we're restoring an existing session (page reload case)
  const isSessionRestore = !!pendingSessionUser;

  // Check if LocalAuth mode is available on mount
  useEffect(() => {
    isLocalAuthMode().then((localAuth) => {
      setIsLocalAuth(localAuth);
      setCheckingAuthMode(false);
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
      // Registration mode: require password confirmation
      if (isRegisterMode) {
        if (password.length < 8) {
          setError('Password must be at least 8 characters');
          return;
        }
        if (password !== confirmPassword) {
          setError('Passwords do not match');
          return;
        }
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
        if (isRegisterMode) {
          await session.localRegister(username, password);
        } else {
          await session.localLogin(username, password);
        }
      } else {
        await session.login(password);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Operation failed';
      // Provide helpful error messages
      if (errorMessage.includes('Invalid credentials')) {
        setError('Invalid username or password. If you don\'t have an account, click "Create Account" below.');
      } else if (errorMessage.includes('Username already exists')) {
        setError('This username is already taken. Please choose a different username or login to your existing account.');
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
            🔐 {isRegisterMode ? 'Create Account' : 'Local Authentication'}
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
              placeholder={isRegisterMode ? 'Create a password (8+ characters)' : 'Enter your password'}
              disabled={loading}
              className="form-input"
              autoFocus
            />
          </div>

          {isLocalAuth && isRegisterMode && !isSessionRestore && (
            <div className="form-group">
              <label htmlFor="confirmPassword" className="form-label">
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                disabled={loading}
                className="form-input"
              />
            </div>
          )}

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
            {loading 
              ? (isRegisterMode ? 'Creating Account...' : 'Signing In...') 
              : (isRegisterMode ? 'Create Account' : 'Sign In')}
          </button>
        </form>

        {isLocalAuth && !isSessionRestore && (
          <button
            type="button"
            onClick={toggleMode}
            className="mode-toggle-button"
            disabled={loading}
          >
            {isRegisterMode 
              ? 'Already have an account? Sign In' 
              : "Don't have an account? Create Account"}
          </button>
        )}

        <p className="login-note">
          {isSessionRestore
            ? 'Your session is still active. Enter your password to unlock encryption.'
            : isLocalAuth
              ? (isRegisterMode 
                  ? 'Create a new account. Choose a strong password - it encrypts your data.'
                  : 'Sign in to your existing account.')
              : 'Your photos are encrypted locally. The server never sees your data.'}
        </p>
      </div>
    </div>
  );
}
