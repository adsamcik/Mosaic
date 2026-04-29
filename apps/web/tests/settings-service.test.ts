/**
 * Settings Service Tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDefaultSettings,
  getIdleTimeoutMs,
  getKeyCacheDurationMs,
  getSetting,
  getSettings,
  getThumbnailQualityValue,
  POLICY_MAX_IDLE_TIMEOUT_MINUTES,
  POLICY_MAX_KEY_CACHE_DURATION_HOURS,
  POLICY_MIN_IDLE_TIMEOUT_MINUTES,
  resetSettings,
  saveSettings,
  setSetting,
  subscribeToSettings,
  updateSettings,
  type UserSettings,
} from '../src/lib/settings-service';

describe('settings-service', () => {
  // Store original localStorage
  let localStorageMock: Record<string, string>;

  beforeEach(() => {
    // Mock localStorage
    localStorageMock = {};
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      (key) => localStorageMock[key] ?? null,
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      localStorageMock[key] = value;
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
      delete localStorageMock[key];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSettings', () => {
    it('returns default settings when no settings are stored', () => {
      const settings = getSettings();

      expect(settings).toEqual({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });
    });

    it('returns stored settings when valid', () => {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
        keyCacheDuration: 60,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      });

      const settings = getSettings();

      expect(settings).toEqual({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
        keyCacheDuration: 60,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      });
    });

    it('returns defaults for invalid values', () => {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 999, // Invalid
        theme: 'invalid', // Invalid
        thumbnailQuality: 'ultra', // Invalid
        autoSync: 'yes', // Invalid (not boolean)
        keyCacheDuration: 999, // Invalid
        originalStorageFormat: 'invalid', // Invalid
        stripExifFromOriginals: 'yes', // Invalid (not boolean)
      });

      const settings = getSettings();

      expect(settings).toEqual({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });
    });

    it('returns defaults for malformed JSON', () => {
      localStorageMock['mosaic:settings'] = 'not valid json';

      const settings = getSettings();

      expect(settings).toEqual({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });
    });

    it('returns defaults for null stored value', () => {
      localStorageMock['mosaic:settings'] = JSON.stringify(null);

      const settings = getSettings();

      expect(settings).toEqual(getDefaultSettings());
    });

    it('preserves valid values and replaces only invalid ones', () => {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 15, // Valid
        theme: 'invalid', // Invalid
        thumbnailQuality: 'low', // Valid
        autoSync: false, // Valid
      });

      const settings = getSettings();

      expect(settings.idleTimeout).toBe(15);
      expect(settings.theme).toBe('dark'); // Default
      expect(settings.thumbnailQuality).toBe('low');
      expect(settings.autoSync).toBe(false);
    });
  });

  describe('saveSettings', () => {
    it('saves settings to localStorage', () => {
      const settings: UserSettings = {
        idleTimeout: 15,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
        keyCacheDuration: 60,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      };

      saveSettings(settings);

      expect(localStorageMock['mosaic:settings']).toBe(
        JSON.stringify(settings),
      );
    });

    it('validates and normalizes settings before saving', () => {
      const invalidSettings = {
        idleTimeout: 999,
        theme: 'invalid',
        thumbnailQuality: 'ultra',
        autoSync: 'yes',
        keyCacheDuration: 999,
        originalStorageFormat: 'invalid',
        stripExifFromOriginals: 'yes',
      } as unknown as UserSettings;

      saveSettings(invalidSettings);

      const saved = JSON.parse(localStorageMock['mosaic:settings']);
      expect(saved.idleTimeout).toBe(30);
      expect(saved.theme).toBe('dark');
      expect(saved.thumbnailQuality).toBe('medium');
      expect(saved.autoSync).toBe(true);
      expect(saved.keyCacheDuration).toBe(30);
      expect(saved.originalStorageFormat).toBe('avif');
      expect(saved.stripExifFromOriginals).toBe(true);
    });

    it('notifies subscribers when settings are saved', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToSettings(callback);

      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
        keyCacheDuration: 240,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
        keyCacheDuration: 240,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      });

      unsubscribe();
    });
  });

  describe('updateSettings', () => {
    it('updates only specified settings', () => {
      saveSettings({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });

      updateSettings({ idleTimeout: 60 });

      const settings = getSettings();
      expect(settings.idleTimeout).toBe(60);
      expect(settings.theme).toBe('dark');
      expect(settings.thumbnailQuality).toBe('medium');
      expect(settings.autoSync).toBe(true);
      expect(settings.keyCacheDuration).toBe(30);
    });

    it('can update multiple settings at once', () => {
      updateSettings({
        idleTimeout: 15,
        theme: 'light',
      });

      const settings = getSettings();
      expect(settings.idleTimeout).toBe(15);
      expect(settings.theme).toBe('light');
    });
  });

  describe('getSetting', () => {
    it('returns specific setting value', () => {
      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
        keyCacheDuration: -1,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      });

      expect(getSetting('idleTimeout')).toBe(60);
      expect(getSetting('theme')).toBe('light');
      expect(getSetting('thumbnailQuality')).toBe('high');
      expect(getSetting('autoSync')).toBe(false);
      expect(getSetting('keyCacheDuration')).toBe(-1);
      expect(getSetting('originalStorageFormat')).toBe('preserve');
    });
  });

  describe('setSetting', () => {
    it('sets specific setting value', () => {
      setSetting('idleTimeout', 15);
      expect(getSetting('idleTimeout')).toBe(15);

      setSetting('theme', 'system');
      expect(getSetting('theme')).toBe('system');
    });
  });

  describe('resetSettings', () => {
    it('removes settings from localStorage', () => {
      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
        keyCacheDuration: 60,
        originalStorageFormat: 'preserve',
        stripExifFromOriginals: true,
      });

      resetSettings();

      expect(localStorageMock['mosaic:settings']).toBeUndefined();
    });

    it('notifies subscribers with default settings', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToSettings(callback);

      resetSettings();

      expect(callback).toHaveBeenCalledWith(getDefaultSettings());

      unsubscribe();
    });
  });

  describe('getDefaultSettings', () => {
    it('returns default settings', () => {
      const defaults = getDefaultSettings();

      expect(defaults).toEqual({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });
    });

    it('returns a new object each time', () => {
      const defaults1 = getDefaultSettings();
      const defaults2 = getDefaultSettings();

      expect(defaults1).not.toBe(defaults2);
      expect(defaults1).toEqual(defaults2);
    });
  });

  describe('getIdleTimeoutMs', () => {
    it('converts idle timeout to milliseconds', () => {
      saveSettings({
        idleTimeout: 15,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });

      expect(getIdleTimeoutMs()).toBe(15 * 60 * 1000);
    });

    it('returns default timeout when no settings stored', () => {
      expect(getIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });
  });

  describe('subscribeToSettings', () => {
    it('calls callback when settings change', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToSettings(callback);

      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('unsubscribe stops callbacks', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToSettings(callback);

      unsubscribe();

      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('supports multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const unsubscribe1 = subscribeToSettings(callback1);
      const unsubscribe2 = subscribeToSettings(callback2);

      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
      });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      unsubscribe1();
      unsubscribe2();
    });
  });

  describe('idle timeout options', () => {
    it('accepts 15 minutes', () => {
      setSetting('idleTimeout', 15);
      expect(getSetting('idleTimeout')).toBe(15);
    });

    it('accepts 30 minutes', () => {
      setSetting('idleTimeout', 30);
      expect(getSetting('idleTimeout')).toBe(30);
    });

    it('accepts 60 minutes', () => {
      setSetting('idleTimeout', 60);
      expect(getSetting('idleTimeout')).toBe(60);
    });
  });

  describe('theme options', () => {
    it('accepts dark theme', () => {
      setSetting('theme', 'dark');
      expect(getSetting('theme')).toBe('dark');
    });

    it('accepts light theme', () => {
      setSetting('theme', 'light');
      expect(getSetting('theme')).toBe('light');
    });

    it('accepts system theme', () => {
      setSetting('theme', 'system');
      expect(getSetting('theme')).toBe('system');
    });
  });

  describe('thumbnail quality options', () => {
    it('accepts low quality', () => {
      setSetting('thumbnailQuality', 'low');
      expect(getSetting('thumbnailQuality')).toBe('low');
    });

    it('accepts medium quality', () => {
      setSetting('thumbnailQuality', 'medium');
      expect(getSetting('thumbnailQuality')).toBe('medium');
    });

    it('accepts high quality', () => {
      setSetting('thumbnailQuality', 'high');
      expect(getSetting('thumbnailQuality')).toBe('high');
    });
  });

  describe('getThumbnailQualityValue', () => {
    it('returns 0.6 for low quality', () => {
      setSetting('thumbnailQuality', 'low');
      expect(getThumbnailQualityValue()).toBe(0.6);
    });

    it('returns 0.8 for medium quality', () => {
      setSetting('thumbnailQuality', 'medium');
      expect(getThumbnailQualityValue()).toBe(0.8);
    });

    it('returns 0.92 for high quality', () => {
      setSetting('thumbnailQuality', 'high');
      expect(getThumbnailQualityValue()).toBe(0.92);
    });

    it('returns 0.8 (medium) by default', () => {
      // No settings stored, uses default
      expect(getThumbnailQualityValue()).toBe(0.8);
    });
  });

  describe('getKeyCacheDurationMs', () => {
    it('returns 0 when disabled', () => {
      setSetting('keyCacheDuration', 0);
      expect(getKeyCacheDurationMs()).toBe(0);
    });

    it('returns Infinity when set to until-tab-close', () => {
      setSetting('keyCacheDuration', -1);
      expect(getKeyCacheDurationMs()).toBe(Infinity);
    });

    it('converts 15 minutes to milliseconds', () => {
      setSetting('keyCacheDuration', 15);
      expect(getKeyCacheDurationMs()).toBe(15 * 60 * 1000);
    });

    it('converts 30 minutes to milliseconds', () => {
      setSetting('keyCacheDuration', 30);
      expect(getKeyCacheDurationMs()).toBe(30 * 60 * 1000);
    });

    it('converts 60 minutes to milliseconds', () => {
      setSetting('keyCacheDuration', 60);
      expect(getKeyCacheDurationMs()).toBe(60 * 60 * 1000);
    });

    it('converts 240 minutes (4 hours) to milliseconds', () => {
      setSetting('keyCacheDuration', 240);
      expect(getKeyCacheDurationMs()).toBe(240 * 60 * 1000);
    });

    it('returns default (30 min) when no settings stored', () => {
      expect(getKeyCacheDurationMs()).toBe(30 * 60 * 1000);
    });
  });

  // ---------------------------------------------------------------------------
  // M8: Policy clamping for security-relevant settings.
  //
  // A user (or attacker with DevTools access on a shared/kiosk device) can
  // write any value to localStorage["mosaic:settings"], bypassing the UI
  // whitelist. The accessors getIdleTimeoutMs() and getKeyCacheDurationMs()
  // must read the raw value and clamp it to a hard policy ceiling/floor so
  // that the auto-logout and cache-eviction security controls cannot be
  // unilaterally weakened by a malicious localStorage write.
  // ---------------------------------------------------------------------------
  describe('policy clamping (M8)', () => {
    /**
     * Helper to write a tampered settings blob directly to the mocked
     * localStorage, simulating an attacker with DevTools access bypassing the
     * UI whitelist. Other settings are filled with defaults.
     */
    function tamperWith(overrides: Record<string, unknown>): void {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
        keyCacheDuration: 30,
        originalStorageFormat: 'avif',
        stripExifFromOriginals: true,
        ...overrides,
      });
    }

    describe('policy constants', () => {
      it('POLICY_MAX_IDLE_TIMEOUT_MINUTES is 60 minutes', () => {
        expect(POLICY_MAX_IDLE_TIMEOUT_MINUTES).toBe(60);
      });

      it('POLICY_MIN_IDLE_TIMEOUT_MINUTES is 5 minutes', () => {
        expect(POLICY_MIN_IDLE_TIMEOUT_MINUTES).toBe(5);
      });

      it('POLICY_MAX_KEY_CACHE_DURATION_HOURS is 8 hours', () => {
        expect(POLICY_MAX_KEY_CACHE_DURATION_HOURS).toBe(8);
      });
    });

    describe('getIdleTimeoutMs clamping', () => {
      it('clamps a tampered idleTimeout above the ceiling to POLICY_MAX', () => {
        // Attacker writes 9999 minutes to disable auto-logout. Must be
        // reduced to POLICY_MAX_IDLE_TIMEOUT_MINUTES, not honoured.
        tamperWith({ idleTimeout: 9999 });

        expect(getIdleTimeoutMs()).toBe(
          POLICY_MAX_IDLE_TIMEOUT_MINUTES * 60 * 1000,
        );
        expect(getIdleTimeoutMs()).not.toBe(9999 * 60 * 1000);
      });

      it('clamps a negative idleTimeout up to POLICY_MIN', () => {
        tamperWith({ idleTimeout: -10 });

        expect(getIdleTimeoutMs()).toBe(
          POLICY_MIN_IDLE_TIMEOUT_MINUTES * 60 * 1000,
        );
      });

      it('clamps a zero idleTimeout up to POLICY_MIN (no instant-logout DoS)', () => {
        tamperWith({ idleTimeout: 0 });

        expect(getIdleTimeoutMs()).toBe(
          POLICY_MIN_IDLE_TIMEOUT_MINUTES * 60 * 1000,
        );
      });

      it('preserves a within-policy idleTimeout (30)', () => {
        tamperWith({ idleTimeout: 30 });

        expect(getIdleTimeoutMs()).toBe(30 * 60 * 1000);
      });

      it('preserves an idleTimeout exactly at POLICY_MAX', () => {
        tamperWith({ idleTimeout: POLICY_MAX_IDLE_TIMEOUT_MINUTES });

        expect(getIdleTimeoutMs()).toBe(
          POLICY_MAX_IDLE_TIMEOUT_MINUTES * 60 * 1000,
        );
      });

      it('returns default idleTimeout when localStorage is empty', () => {
        expect(getIdleTimeoutMs()).toBe(
          getDefaultSettings().idleTimeout * 60 * 1000,
        );
      });

      it('falls back to default when idleTimeout is a non-numeric type (string)', () => {
        tamperWith({ idleTimeout: 'forever' });

        expect(getIdleTimeoutMs()).toBe(
          getDefaultSettings().idleTimeout * 60 * 1000,
        );
      });

      it('falls back to default when idleTimeout is NaN', () => {
        // JSON cannot represent NaN; a hand-crafted blob that contains "NaN"
        // would fail JSON.parse. We instead simulate a non-finite value
        // surviving JSON parsing by writing null, which is also rejected.
        tamperWith({ idleTimeout: null });

        expect(getIdleTimeoutMs()).toBe(
          getDefaultSettings().idleTimeout * 60 * 1000,
        );
      });

      it('falls back to default when settings JSON is malformed', () => {
        localStorageMock['mosaic:settings'] = 'not valid json';

        expect(getIdleTimeoutMs()).toBe(
          getDefaultSettings().idleTimeout * 60 * 1000,
        );
      });
    });

    describe('getKeyCacheDurationMs clamping', () => {
      it('clamps a tampered keyCacheDuration above the ceiling to POLICY_MAX', () => {
        // Attacker writes 99999 minutes (~70 days) to keep keys cached
        // indefinitely. Must be reduced to the policy ceiling.
        tamperWith({ keyCacheDuration: 99999 });

        const expectedMs =
          POLICY_MAX_KEY_CACHE_DURATION_HOURS * 60 * 60 * 1000;
        expect(getKeyCacheDurationMs()).toBe(expectedMs);
        expect(getKeyCacheDurationMs()).not.toBe(99999 * 60 * 1000);
      });

      it('preserves the disabled sentinel (0)', () => {
        tamperWith({ keyCacheDuration: 0 });

        expect(getKeyCacheDurationMs()).toBe(0);
      });

      it('preserves the until-tab-close sentinel (-1)', () => {
        tamperWith({ keyCacheDuration: -1 });

        expect(getKeyCacheDurationMs()).toBe(Infinity);
      });

      it('clamps a non-sentinel negative keyCacheDuration up to 0', () => {
        // -50 is not the documented -1 sentinel; treat as out-of-range.
        tamperWith({ keyCacheDuration: -50 });

        expect(getKeyCacheDurationMs()).toBe(0);
      });

      it('preserves a within-policy keyCacheDuration (60 minutes)', () => {
        tamperWith({ keyCacheDuration: 60 });

        expect(getKeyCacheDurationMs()).toBe(60 * 60 * 1000);
      });

      it('preserves a within-policy keyCacheDuration (240 minutes / 4h)', () => {
        // 240 < POLICY_MAX_KEY_CACHE_DURATION_HOURS * 60 (= 480), so unchanged.
        tamperWith({ keyCacheDuration: 240 });

        expect(getKeyCacheDurationMs()).toBe(240 * 60 * 1000);
      });

      it('returns default keyCacheDuration when localStorage is empty', () => {
        expect(getKeyCacheDurationMs()).toBe(
          getDefaultSettings().keyCacheDuration * 60 * 1000,
        );
      });

      it('falls back to default when keyCacheDuration is non-numeric', () => {
        tamperWith({ keyCacheDuration: 'forever' });

        expect(getKeyCacheDurationMs()).toBe(
          getDefaultSettings().keyCacheDuration * 60 * 1000,
        );
      });
    });
  });
});
