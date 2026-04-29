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
  /**
   * Strip EXIF / IPTC metadata (GPS, device serial, timestamps) from JPEG
   * originals before they are encrypted and uploaded. Default: true. Only
   * applies to JPEG; HEIC/PNG/WebP/AVIF are passed through unchanged for v1.
   */
  stripExifFromOriginals: boolean;
}

// =============================================================================
// Security Policy (M8)
// =============================================================================
//
// Settings such as `idleTimeout` and `keyCacheDuration` control client-side
// security behaviour (auto-logout, key cache eviction). They are stored in
// localStorage, which is fully writable by anyone with DevTools access on a
// shared/kiosk device. The UI whitelist alone is not sufficient — an attacker
// can bypass it with a single `localStorage.setItem(...)` call.
//
// Defense in depth: the public accessors below read the raw localStorage
// value (bypassing the whitelist validator) and clamp the user preference
// against compile-time policy constants before applying it. A malicious
// write of `{ idleTimeout: 9999 }` is reduced to POLICY_MAX_IDLE_TIMEOUT_MINUTES.
//
// FOLLOW-UP: For true kiosk-grade enforcement the server should push policy
// (idle timeout, key-cache cap) via `/api/auth/config`, and the client should
// clamp against that server-pushed value rather than only a compile-time
// constant. This is tracked separately and intentionally out of scope for v1.

/**
 * Maximum idle timeout (in minutes) the running client will honour,
 * regardless of the value the user has stored in localStorage. (M8)
 */
export const POLICY_MAX_IDLE_TIMEOUT_MINUTES = 60;

/**
 * Minimum idle timeout (in minutes) the running client will honour. Negative
 * or zero values written by an attacker are clamped up to this floor so a
 * hostile localStorage write cannot accidentally produce a denial-of-service
 * (instant logout) either. (M8)
 */
export const POLICY_MIN_IDLE_TIMEOUT_MINUTES = 5;

/**
 * Maximum key-cache duration (in hours) the running client will honour.
 * Same rationale as POLICY_MAX_IDLE_TIMEOUT_MINUTES: key caching is a UX
 * convenience and must not be unilaterally extended by the user beyond this
 * ceiling. The documented sentinel values (0 = disabled, -1 = until tab
 * close) are preserved for UX continuity; capping the "until tab close"
 * sentinel against this ceiling is tracked as a follow-up. (M8)
 */
export const POLICY_MAX_KEY_CACHE_DURATION_HOURS = 8;

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
  stripExifFromOriginals: true, // Privacy default: strip EXIF from JPEG originals
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
    stripExifFromOriginals:
      typeof s.stripExifFromOriginals === 'boolean'
        ? s.stripExifFromOriginals
        : DEFAULT_SETTINGS.stripExifFromOriginals,
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
 * Read the raw JSON object stored at SETTINGS_KEY without running it through
 * `validateSettings`. Security-relevant accessors use this so that the
 * policy clamp is enforced even if the validator's whitelist is later
 * relaxed or bypassed. Returns an empty object when the key is missing,
 * malformed, or not an object. (M8)
 */
function readRawSettingsObject(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Get idle timeout in milliseconds, clamped to the security policy range
 * `[POLICY_MIN_IDLE_TIMEOUT_MINUTES, POLICY_MAX_IDLE_TIMEOUT_MINUTES]`.
 *
 * Reads the raw user preference from localStorage rather than going through
 * `getSettings()` so the clamp is enforced even when a malicious value
 * (e.g. `idleTimeout: 9999`) bypasses the validator's whitelist. A
 * non-numeric or non-finite value falls back to the default. (M8)
 */
export function getIdleTimeoutMs(): number {
  const raw = readRawSettingsObject().idleTimeout;
  const userPref =
    typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : DEFAULT_SETTINGS.idleTimeout;
  const clamped = Math.min(
    POLICY_MAX_IDLE_TIMEOUT_MINUTES,
    Math.max(POLICY_MIN_IDLE_TIMEOUT_MINUTES, userPref),
  );
  return clamped * 60 * 1000;
}

/**
 * Get key cache duration in milliseconds.
 *
 * Returns the documented sentinels unchanged: `0` = disabled, `-1` = Infinity
 * (until tab close). For non-sentinel numeric values the result is clamped
 * to `[0, POLICY_MAX_KEY_CACHE_DURATION_HOURS * 60]` minutes before being
 * converted to milliseconds. Reads the raw value (bypassing the whitelist
 * validator) so that a tampered localStorage write of e.g.
 * `{ keyCacheDuration: 99999 }` is reduced to the policy ceiling. (M8)
 */
export function getKeyCacheDurationMs(): number {
  const raw = readRawSettingsObject().keyCacheDuration;

  // Documented sentinels — preserved as-is for UX continuity.
  if (raw === 0) return 0; // Disabled
  if (raw === -1) return Infinity; // Until tab close

  const userPref =
    typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : DEFAULT_SETTINGS.keyCacheDuration;

  const maxMinutes = POLICY_MAX_KEY_CACHE_DURATION_HOURS * 60;
  const clamped = Math.min(maxMinutes, Math.max(0, userPref));
  return clamped * 60 * 1000;
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

/**
 * Check if EXIF / IPTC metadata should be stripped from JPEG originals
 * before encryption. Default: true. Only JPEG is currently stripped; other
 * formats pass through unchanged regardless of this setting.
 */
export function shouldStripExifFromOriginals(): boolean {
  return getSettings().stripExifFromOriginals;
}
