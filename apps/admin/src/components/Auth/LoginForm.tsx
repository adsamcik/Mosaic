import { useState } from 'react';
import { session } from '../../lib/session';

/**
 * Login Form Component
 * Handles password entry and session initialization
 */
export function LoginForm() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!password.trim()) {
      setError('Please enter a password');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await session.login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container" data-testid="login-form">
      <div className="login-card">
        <h1 className="login-title">🖼️ Mosaic</h1>
        <p className="login-subtitle">Zero-knowledge encrypted photo gallery</p>
        
        <form onSubmit={handleSubmit} className="login-form">
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
          Your photos are encrypted locally. The server never sees your data.
        </p>
      </div>
    </div>
  );
}
