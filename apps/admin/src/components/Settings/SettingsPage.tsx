/**
 * Settings Page Component
 *
 * User settings page with sections for:
 * - Account info
 * - Storage quota
 * - Session settings
 * - Security
 * - About
 */

import { useCallback, useEffect, useState } from 'react';
import { clearAllCovers } from '../../lib/album-cover-service';
import { clearAllCachedMetadata } from '../../lib/album-metadata-service';
import { getApi } from '../../lib/api';
import type { User } from '../../lib/api-types';
import { closeDbClient } from '../../lib/db-client';
import { clearAllEpochKeys } from '../../lib/epoch-key-store';
import { session } from '../../lib/session';
import {
    getDefaultSettings,
    getSettings,
    saveSettings,
    type IdleTimeoutMinutes,
    type Theme,
    type ThumbnailQuality,
    type UserSettings,
} from '../../lib/settings-service';

// =============================================================================
// Types
// =============================================================================

interface StorageQuota {
  used: number;
  max: number;
}

// =============================================================================
// Helpers
// =============================================================================

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Format date to readable string */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return 'Unknown';
  }
}

/** Truncate a string with ellipsis */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(-half)}`;
}

// =============================================================================
// Component
// =============================================================================

export function SettingsPage() {
  // User state
  const [user, setUser] = useState<User | null>(null);
  const [storageQuota, setStorageQuota] = useState<StorageQuota | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);

  // Settings state
  const [settings, setSettings] = useState<UserSettings>(getSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Clear data state
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  // Load user data
  useEffect(() => {
    const loadUserData = async () => {
      try {
        setIsLoadingUser(true);
        setUserError(null);

        const api = getApi();
        const userData = await api.getCurrentUser();
        setUser(userData);

        // Try to get storage quota from browser's Storage API
        if (navigator.storage?.estimate) {
          const estimate = await navigator.storage.estimate();
          setStorageQuota({
            used: estimate.usage ?? 0,
            max: estimate.quota ?? 0,
          });
        }
      } catch (err) {
        setUserError(err instanceof Error ? err.message : 'Failed to load user data');
      } finally {
        setIsLoadingUser(false);
      }
    };

    void loadUserData();
  }, []);

  // Handle settings change
  const handleSettingsChange = useCallback(
    <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // Save settings
  const handleSaveSettings = useCallback(async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      saveSettings(settings);
      setSaveMessage('Settings saved successfully');
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err) {
      setSaveMessage('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  // Reset settings to defaults
  const handleResetSettings = useCallback(() => {
    setSettings(getDefaultSettings());
  }, []);

  // Clear local data
  const handleClearLocalData = useCallback(async () => {
    setIsClearing(true);
    setClearError(null);
    try {
      // Clear in-memory caches
      clearAllCachedMetadata();
      clearAllCovers();
      clearAllEpochKeys();

      // Close and clear database
      await closeDbClient();

      // Clear OPFS storage if available
      if ('storage' in navigator && 'getDirectory' in navigator.storage) {
        try {
          const root = await navigator.storage.getDirectory();
          // Try to remove our database files
          for await (const name of (root as any).keys()) {
            if (name.startsWith('mosaic')) {
              await root.removeEntry(name, { recursive: true });
            }
          }
        } catch {
          // OPFS not available or already cleared
        }
      }

      // Clear IndexedDB
      const databases = await indexedDB.databases?.();
      if (databases) {
        for (const db of databases) {
          if (db.name?.includes('mosaic')) {
            indexedDB.deleteDatabase(db.name);
          }
        }
      }

      setShowClearConfirm(false);
      // Force logout after clearing data
      await session.logout();
    } catch (err) {
      setClearError(err instanceof Error ? err.message : 'Failed to clear data');
    } finally {
      setIsClearing(false);
    }
  }, []);

  // Calculate storage percentage
  const storagePercent =
    storageQuota && storageQuota.max > 0
      ? Math.round((storageQuota.used / storageQuota.max) * 100)
      : 0;

  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="settings-header">
        <h1 className="settings-title">Settings</h1>
      </div>

      <div className="settings-content">
        {/* Account Info Section */}
        <section className="settings-section" data-testid="account-section">
          <h2 className="section-title">Account</h2>
          <div className="settings-card">
            {isLoadingUser ? (
              <div className="settings-loading">
                <div className="loading-spinner" />
                <span>Loading account info...</span>
              </div>
            ) : userError ? (
              <div className="settings-error">
                <span className="error-icon">⚠️</span>
                <span>{userError}</span>
              </div>
            ) : user ? (
              <div className="account-info">
                <div className="info-row">
                  <span className="info-label">User ID</span>
                  <span className="info-value" title={user.id}>
                    {truncate(user.id, 20)}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Identity Public Key</span>
                  <span
                    className="info-value info-mono"
                    title={user.identityPubkey ?? 'Not set'}
                  >
                    {user.identityPubkey ? truncate(user.identityPubkey, 24) : 'Not set'}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Account Created</span>
                  <span className="info-value">{formatDate(user.createdAt)}</span>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* Storage Quota Section */}
        <section className="settings-section" data-testid="storage-section">
          <h2 className="section-title">Storage</h2>
          <div className="settings-card">
            {storageQuota ? (
              <div className="storage-info">
                <div className="storage-bar">
                  <div
                    className="storage-bar-fill"
                    style={{ width: `${Math.min(storagePercent, 100)}%` }}
                    data-testid="storage-bar-fill"
                  />
                </div>
                <div className="storage-details">
                  <span className="storage-used">
                    {formatBytes(storageQuota.used)} used
                  </span>
                  <span className="storage-percent">{storagePercent}%</span>
                  <span className="storage-max">
                    {formatBytes(storageQuota.max)} total
                  </span>
                </div>
              </div>
            ) : (
              <div className="storage-info">
                <span className="text-muted">Storage quota unavailable</span>
              </div>
            )}
          </div>
        </section>

        {/* Session Settings Section */}
        <section className="settings-section" data-testid="session-section">
          <h2 className="section-title">Session</h2>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Idle Timeout</span>
                <span className="setting-description">
                  Automatically log out after inactivity
                </span>
              </div>
              <select
                className="setting-select"
                value={settings.idleTimeout}
                onChange={(e) =>
                  handleSettingsChange(
                    'idleTimeout',
                    parseInt(e.target.value, 10) as IdleTimeoutMinutes
                  )
                }
                data-testid="idle-timeout-select"
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>60 minutes</option>
              </select>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Theme</span>
                <span className="setting-description">
                  Choose your preferred color scheme
                </span>
              </div>
              <select
                className="setting-select"
                value={settings.theme}
                onChange={(e) =>
                  handleSettingsChange('theme', e.target.value as Theme)
                }
                data-testid="theme-select"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </select>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Thumbnail Quality</span>
                <span className="setting-description">
                  Higher quality uses more storage
                </span>
              </div>
              <select
                className="setting-select"
                value={settings.thumbnailQuality}
                onChange={(e) =>
                  handleSettingsChange(
                    'thumbnailQuality',
                    e.target.value as ThumbnailQuality
                  )
                }
                data-testid="thumbnail-quality-select"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Auto Sync</span>
                <span className="setting-description">
                  Automatically sync albums in background
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.autoSync}
                  onChange={(e) =>
                    handleSettingsChange('autoSync', e.target.checked)
                  }
                  data-testid="auto-sync-toggle"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="settings-actions">
              <button
                className="button-secondary"
                onClick={handleResetSettings}
                type="button"
              >
                Reset to Defaults
              </button>
              <button
                className="button-primary"
                onClick={handleSaveSettings}
                disabled={isSaving}
                type="button"
              >
                {isSaving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
            {saveMessage && (
              <div
                className={`save-message ${
                  saveMessage.includes('success') ? 'success' : 'error'
                }`}
              >
                {saveMessage}
              </div>
            )}
          </div>
        </section>

        {/* Security Section */}
        <section className="settings-section" data-testid="security-section">
          <h2 className="section-title">Security</h2>
          <div className="settings-card">
            <div className="info-row">
              <span className="info-label">Last Login</span>
              <span className="info-value">This session</span>
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">Clear Local Data</span>
                <span className="setting-description">
                  Delete cached photos, keys, and database. You will be logged out.
                </span>
              </div>
              <button
                className="button-danger"
                onClick={() => setShowClearConfirm(true)}
                type="button"
                data-testid="clear-data-button"
              >
                Clear Data
              </button>
            </div>
            {clearError && (
              <div className="settings-error">
                <span className="error-icon">⚠️</span>
                <span>{clearError}</span>
              </div>
            )}
          </div>
        </section>

        {/* About Section */}
        <section className="settings-section" data-testid="about-section">
          <h2 className="section-title">About</h2>
          <div className="settings-card">
            <div className="info-row">
              <span className="info-label">Version</span>
              <span className="info-value">1.0.0</span>
            </div>
            <div className="info-row">
              <span className="info-label">Documentation</span>
              <a
                href="https://github.com/mosaic/mosaic"
                target="_blank"
                rel="noopener noreferrer"
                className="info-link"
              >
                View on GitHub
              </a>
            </div>
            <div className="about-description">
              <p>
                Mosaic is a zero-knowledge encrypted photo gallery. Your photos
                are encrypted client-side before being uploaded—the server never
                sees your plaintext data.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Clear Data Confirmation Dialog */}
      {showClearConfirm && (
        <div
          className="dialog-backdrop"
          onClick={() => !isClearing && setShowClearConfirm(false)}
          data-testid="clear-confirm-dialog"
        >
          <div
            className="dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-dialog-title"
          >
            <div className="dialog-form">
              <h3 className="dialog-title" id="clear-dialog-title">
                Clear Local Data?
              </h3>
              <p className="dialog-description">
                This will permanently delete all cached data including:
              </p>
              <ul className="clear-data-list">
                <li>Photo thumbnails and cache</li>
                <li>Local SQLite database</li>
                <li>Epoch key cache</li>
                <li>Session data</li>
              </ul>
              <p className="dialog-description">
                You will be logged out and will need to re-sync your albums.
              </p>
              <div className="dialog-actions">
                <button
                  className="button-secondary"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={isClearing}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="button-danger"
                  onClick={handleClearLocalData}
                  disabled={isClearing}
                  type="button"
                  data-testid="confirm-clear-button"
                >
                  {isClearing ? 'Clearing...' : 'Clear Data'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
