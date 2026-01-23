/**
 * Settings Page Component
 *
 * User settings page with sections for:
 * - Account info
 * - Storage quota
 * - Language
 * - Session settings
 * - Security
 * - About
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearAllCovers } from '../../lib/album-cover-service';
import { clearAllCachedMetadata } from '../../lib/album-metadata-service';
import { getApi } from '../../lib/api';
import type { User } from '../../lib/api-types';
import { closeDbClient } from '../../lib/db-client';
import { clearAllEpochKeys } from '../../lib/epoch-key-store';
import {
  changeLanguage,
  getCurrentLanguage,
  supportedLanguages,
  type SupportedLanguage,
} from '../../lib/i18n';
import { session } from '../../lib/session';
import {
  getDefaultSettings,
  getSettings,
  saveSettings,
  type IdleTimeoutMinutes,
  type KeyCacheDuration,
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
function formatDate(dateStr: string | undefined, locale?: string): string {
  if (!dateStr) return 'Unknown';
  try {
    return new Date(dateStr).toLocaleDateString(locale, {
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
  const { t, i18n } = useTranslation();

  // Language state
  const [currentLanguage, setCurrentLanguage] =
    useState<SupportedLanguage>(getCurrentLanguage);

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
        setUserError(
          err instanceof Error ? err.message : 'Failed to load user data',
        );
      } finally {
        setIsLoadingUser(false);
      }
    };

    void loadUserData();
  }, []);

  // Handle settings change
  // For visual settings (theme, language), apply immediately for instant feedback
  const handleSettingsChange = useCallback(
    <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
      setSettings((prev) => {
        const newSettings = { ...prev, [key]: value };
        // Auto-save visual settings immediately for instant feedback
        if (key === 'theme') {
          saveSettings(newSettings);
        }
        return newSettings;
      });
    },
    [],
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

  // Handle language change
  const handleLanguageChange = useCallback(async (lang: SupportedLanguage) => {
    await changeLanguage(lang);
    setCurrentLanguage(lang);
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
          // FileSystemDirectoryHandle.keys() returns AsyncIterable<string>
          // Use type assertion as TypeScript's lib.dom.d.ts doesn't include OPFS iteration yet
          const rootWithIterator = root as FileSystemDirectoryHandle & {
            keys(): AsyncIterable<string>;
          };
          for await (const name of rootWithIterator.keys()) {
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
      setClearError(
        err instanceof Error ? err.message : 'Failed to clear data',
      );
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
        <h1 className="settings-title">{t('settings.title')}</h1>
      </div>

      <div className="settings-content">
        {/* Account Info Section */}
        <section className="settings-section" data-testid="account-section">
          <h2 className="section-title">{t('settings.account.title')}</h2>
          <div className="settings-card">
            {isLoadingUser ? (
              <div className="settings-loading">
                <div className="loading-spinner" />
                <span>{t('settings.account.loading')}</span>
              </div>
            ) : userError ? (
              <div className="settings-error">
                <span className="error-icon">⚠️</span>
                <span>{userError}</span>
              </div>
            ) : user ? (
              <div className="account-info">
                <div className="info-row">
                  <span className="info-label">
                    {t('settings.account.userId')}
                  </span>
                  <span className="info-value" title={user.id}>
                    {truncate(user.id, 20)}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">
                    {t('settings.account.publicKey')}
                  </span>
                  <span
                    className="info-value info-mono"
                    title={user.identityPubkey ?? t('common.notSet')}
                  >
                    {user.identityPubkey
                      ? truncate(user.identityPubkey, 24)
                      : t('common.notSet')}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">
                    {t('settings.account.createdAt')}
                  </span>
                  <span className="info-value">
                    {formatDate(user.createdAt, i18n.language)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* Storage Quota Section */}
        <section className="settings-section" data-testid="storage-section">
          <h2 className="section-title">{t('settings.storage.title')}</h2>
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
                    {t('settings.storage.used', {
                      used: formatBytes(storageQuota.used),
                    })}
                  </span>
                  <span className="storage-percent">
                    {t('common.percent', { value: storagePercent })}
                  </span>
                  <span className="storage-max">
                    {t('settings.storage.of', {
                      total: formatBytes(storageQuota.max),
                    })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="storage-info">
                <span className="text-muted">
                  {t('settings.storage.unavailable')}
                </span>
              </div>
            )}
          </div>
        </section>

        {/* Language Section */}
        <section className="settings-section" data-testid="language-section">
          <h2 className="section-title">{t('settings.language.title')}</h2>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.language.title')}
                </span>
                <span className="setting-description">
                  {t('settings.language.description')}
                </span>
              </div>
              <select
                className="setting-select"
                value={currentLanguage}
                onChange={(e) =>
                  void handleLanguageChange(e.target.value as SupportedLanguage)
                }
                data-testid="language-select"
              >
                {supportedLanguages.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.nativeName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Session Settings Section */}
        <section className="settings-section" data-testid="session-section">
          <h2 className="section-title">{t('settings.session.title')}</h2>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.session.idleTimeout')}
                </span>
                <span className="setting-description">
                  {t('settings.session.idleTimeoutDescription')}
                </span>
              </div>
              <select
                className="setting-select"
                value={settings.idleTimeout}
                onChange={(e) =>
                  handleSettingsChange(
                    'idleTimeout',
                    parseInt(e.target.value, 10) as IdleTimeoutMinutes,
                  )
                }
                data-testid="idle-timeout-select"
              >
                <option value={15}>{t('settings.session.minutes15')}</option>
                <option value={30}>{t('settings.session.minutes30')}</option>
                <option value={60}>{t('settings.session.minutes60')}</option>
              </select>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.session.theme')}
                </span>
                <span className="setting-description">
                  {t('settings.session.themeDescription')}
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
                <option value="dark">{t('settings.session.themeDark')}</option>
                <option value="light">
                  {t('settings.session.themeLight')}
                </option>
                <option value="system">
                  {t('settings.session.themeSystem')}
                </option>
              </select>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.session.thumbnailQuality')}
                </span>
                <span className="setting-description">
                  {t('settings.session.thumbnailQualityDescription')}
                </span>
              </div>
              <select
                className="setting-select"
                value={settings.thumbnailQuality}
                onChange={(e) =>
                  handleSettingsChange(
                    'thumbnailQuality',
                    e.target.value as ThumbnailQuality,
                  )
                }
                data-testid="thumbnail-quality-select"
              >
                <option value="low">{t('settings.session.qualityLow')}</option>
                <option value="medium">
                  {t('settings.session.qualityMedium')}
                </option>
                <option value="high">
                  {t('settings.session.qualityHigh')}
                </option>
              </select>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.session.autoSync')}
                </span>
                <span className="setting-description">
                  {t('settings.session.autoSyncDescription')}
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

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.session.rememberSession')}
                </span>
                <span className="setting-description">
                  {t('settings.session.rememberSessionDescription')}
                </span>
              </div>
              <select
                className="setting-select"
                value={settings.keyCacheDuration}
                onChange={(e) =>
                  handleSettingsChange(
                    'keyCacheDuration',
                    parseInt(e.target.value, 10) as KeyCacheDuration,
                  )
                }
                data-testid="key-cache-duration-select"
              >
                <option value={0}>{t('settings.session.cacheOff')}</option>
                <option value={15}>{t('settings.session.cache15min')}</option>
                <option value={30}>{t('settings.session.cache30min')}</option>
                <option value={60}>{t('settings.session.cache1hour')}</option>
                <option value={240}>{t('settings.session.cache4hours')}</option>
                <option value={-1}>
                  {t('settings.session.cacheUntilClose')}
                </option>
              </select>
            </div>

            <div className="settings-actions">
              <button
                className="button-secondary"
                onClick={handleResetSettings}
                type="button"
              >
                {t('settings.resetToDefaults')}
              </button>
              <button
                className="button-primary"
                onClick={handleSaveSettings}
                disabled={isSaving}
                type="button"
              >
                {isSaving ? t('common.saving') : t('settings.saveSettings')}
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
          <h2 className="section-title">{t('settings.security.title')}</h2>
          <div className="settings-card">
            <div className="info-row">
              <span className="info-label">
                {t('settings.security.lastLogin')}
              </span>
              <span className="info-value">
                {t('settings.security.thisSession')}
              </span>
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t('settings.security.clearLocalData')}
                </span>
                <span className="setting-description">
                  {t('settings.security.clearLocalDataDescription')}
                </span>
              </div>
              <button
                className="button-danger"
                onClick={() => setShowClearConfirm(true)}
                type="button"
                data-testid="clear-data-button"
              >
                {t('settings.security.clearData')}
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
          <h2 className="section-title">{t('settings.about.title')}</h2>
          <div className="settings-card">
            <div className="info-row">
              <span className="info-label">{t('settings.about.version')}</span>
              <span className="info-value">1.0.0</span>
            </div>
            <div className="info-row">
              <span className="info-label">
                {t('settings.about.documentation')}
              </span>
              <a
                href="https://github.com/mosaic/mosaic"
                target="_blank"
                rel="noopener noreferrer"
                className="info-link"
              >
                {t('settings.about.viewOnGithub')}
              </a>
            </div>
            <div className="about-description">
              <p>{t('settings.about.description')}</p>
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
                {t('settings.clearDataDialog.title')}
              </h3>
              <p className="dialog-description">
                {t('settings.clearDataDialog.description')}
              </p>
              <ul className="clear-data-list">
                <li>{t('settings.clearDataDialog.item1')}</li>
                <li>{t('settings.clearDataDialog.item2')}</li>
                <li>{t('settings.clearDataDialog.item3')}</li>
                <li>{t('settings.clearDataDialog.item4')}</li>
              </ul>
              <p className="dialog-description">
                {t('settings.clearDataDialog.warning')}
              </p>
              <div className="dialog-actions">
                <button
                  className="button-secondary"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={isClearing}
                  type="button"
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="button-danger"
                  onClick={handleClearLocalData}
                  disabled={isClearing}
                  type="button"
                  data-testid="confirm-clear-button"
                >
                  {isClearing
                    ? t('common.clearing')
                    : t('settings.security.clearData')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
