/**
 * Settings Service
 *
 * Manages user preferences stored in localStorage.
 * Provides type-safe access to settings with defaults.
 */

// =============================================================================
// Types
// =============================================================================

/** Idle timeout options in minutes */
export type IdleTimeoutMinutes = 15 | 30 | 60;

/** Theme options */
export type Theme = 'dark' | 'light' | 'system';

/** Key cache duration options (0 = disabled, -1 = until tab close, positive = minutes) */
export type KeyCacheDuration = 0 | 15 | 30 | 60 | 240 | -1;

/** Thumbnail quality options */
export type ThumbnailQuality = 'low' | 'medium' | 'high';

/** Original image storage format options */
export type OriginalStorageFormat = 'avif' | 'preserve';

/** User settings interface */
export interface UserSettings {
  /** Idle timeout in minutes before auto-logout */
  idleTimeout: IdleTimeoutMinutes;
  /** UI theme preference */
  theme: Theme;
  /** Thumbnail generation quality */
  thumbnailQuality: ThumbnailQuality;
  /** Automatically sync in background */
  autoSync: boolean;
  /** Key cache duration: 0=off, -1=until tab close, positive=minutes */
  keyCacheDuration: KeyCacheDuration;
  /** Store original images as AVIF for better compression (default: true) */
  originalStorageFormat: OriginalStorageFormat;
}

// =============================================================================
// Constants
// =============================================================================

/** LocalStorage key for settings */
const SETTINGS_KEY = 'mosaic:settings';

/** Default settings values */
const DEFAULT_SETTINGS: UserSettings = {
  idleTimeout: 30,
  theme: 'dark',
  thumbnailQuality: 'medium',
  autoSync: true,
  keyCacheDuration: 30, // 30 minutes by default
  originalStorageFormat: 'avif', // Convert originals to AVIF for better compression
};

/** Valid idle timeout values */
const VALID_IDLE_TIMEOUTS: IdleTimeoutMinutes[] = [15, 30, 60];

/** Valid key cache duration values */
const VALID_KEY_CACHE_DURATIONS: KeyCacheDuration[] = [0, 15, 30, 60, 240, -1];

/** Valid theme values */
const VALID_THEMES: Theme[] = ['dark', 'light', 'system'];

/** Valid thumbnail quality values */
const VALID_THUMBNAIL_QUALITIES: ThumbnailQuality[] = ['low', 'medium', 'high'];

/** Valid original storage format values */
const VALID_ORIGINAL_FORMATS: OriginalStorageFormat[] = ['avif', 'preserve'];

// =============================================================================
// Settings Listeners
// =============================================================================

type SettingsListener = (settings: UserSettings) => void;
const listeners = new Set<SettingsListener>();

/**
 * Subscribe to settings changes.
 * @param callback - Function called when settings change
 * @returns Unsubscribe function
 */
export function subscribeToSettings(callback: SettingsListener): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Notify all listeners of settings change */
function notifyListeners(settings: UserSettings): void {
  listeners.forEach((cb) => cb(settings));
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate and normalize settings object.
 * Invalid values are replaced with defaults.
 */
function validateSettings(settings: unknown): UserSettings {
  if (typeof settings !== 'object' || settings === null) {
    return { ...DEFAULT_SETTINGS };
  }

  const s = settings as Record<string, unknown>;

  return {
    idleTimeout: VALID_IDLE_TIMEOUTS.includes(
      s.idleTimeout as IdleTimeoutMinutes,
    )
      ? (s.idleTimeout as IdleTimeoutMinutes)
      : DEFAULT_SETTINGS.idleTimeout,
    theme: VALID_THEMES.includes(s.theme as Theme)
      ? (s.theme as Theme)
      : DEFAULT_SETTINGS.theme,
    thumbnailQuality: VALID_THUMBNAIL_QUALITIES.includes(
      s.thumbnailQuality as ThumbnailQuality,
    )
      ? (s.thumbnailQuality as ThumbnailQuality)
      : DEFAULT_SETTINGS.thumbnailQuality,
    autoSync:
      typeof s.autoSync === 'boolean' ? s.autoSync : DEFAULT_SETTINGS.autoSync,
    keyCacheDuration: VALID_KEY_CACHE_DURATIONS.includes(
      s.keyCacheDuration as KeyCacheDuration,
    )
      ? (s.keyCacheDuration as KeyCacheDuration)
      : DEFAULT_SETTINGS.keyCacheDuration,
    originalStorageFormat: VALID_ORIGINAL_FORMATS.includes(
      s.originalStorageFormat as OriginalStorageFormat,
    )
      ? (s.originalStorageFormat as OriginalStorageFormat)
      : DEFAULT_SETTINGS.originalStorageFormat,
  };
}

// =============================================================================
// Settings Operations
// =============================================================================

/**
 * Get all user settings.
 * Returns defaults for any missing or invalid values.
 */
export function getSettings(): UserSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) {
      return { ...DEFAULT_SETTINGS };
    }
    return validateSettings(JSON.parse(stored));
  } catch {
    // If parsing fails, return defaults
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save all user settings.
 * Validates and normalizes values before saving.
 */
export function saveSettings(settings: UserSettings): void {
  const validated = validateSettings(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(validated));
  notifyListeners(validated);
}

/**
 * Update specific settings while preserving others.
 * @param updates - Partial settings to update
 */
export function updateSettings(updates: Partial<UserSettings>): void {
  const current = getSettings();
  saveSettings({ ...current, ...updates });
}

/**
 * Get a specific setting value.
 */
export function getSetting<K extends keyof UserSettings>(
  key: K,
): UserSettings[K] {
  return getSettings()[key];
}

/**
 * Set a specific setting value.
 */
export function setSetting<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K],
): void {
  updateSettings({ [key]: value });
}

/**
 * Reset all settings to defaults.
 */
export function resetSettings(): void {
  localStorage.removeItem(SETTINGS_KEY);
  notifyListeners({ ...DEFAULT_SETTINGS });
}

/**
 * Get default settings (useful for comparison/reset UI).
 */
export function getDefaultSettings(): UserSettings {
  return { ...DEFAULT_SETTINGS };
}

/**
 * Get idle timeout in milliseconds.
 */
export function getIdleTimeoutMs(): number {
  return getSettings().idleTimeout * 60 * 1000;
}

/**
 * Get key cache duration in milliseconds.
 * Returns 0 for disabled, Infinity for until-tab-close.
 */
export function getKeyCacheDurationMs(): number {
  const duration = getSettings().keyCacheDuration;
  if (duration === 0) return 0; // Disabled
  if (duration === -1) return Infinity; // Until tab close
  return duration * 60 * 1000; // Convert minutes to ms
}

/**
 * Get thumbnail quality as a numeric value (0-1).
 * Maps user-friendly settings to JPEG quality values.
 */
export function getThumbnailQualityValue(): number {
  const quality = getSettings().thumbnailQuality;
  switch (quality) {
    case 'low':
      return 0.6;
    case 'medium':
      return 0.8;
    case 'high':
      return 0.92;
    default:
      return 0.8; // Default to medium
  }
}

/**
 * Check if original images should be stored as AVIF.
 * When true, originals are converted to AVIF for better compression.
 * When false, original file format is preserved.
 */
export function shouldStoreOriginalsAsAvif(): boolean {
  return getSettings().originalStorageFormat === 'avif';
}
