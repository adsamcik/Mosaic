/**
 * Settings Service Tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getDefaultSettings,
    getIdleTimeoutMs,
    getSetting,
    getSettings,
    getThumbnailQualityValue,
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
      (key) => localStorageMock[key] ?? null
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
      });
    });

    it('returns stored settings when valid', () => {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
      });

      const settings = getSettings();

      expect(settings).toEqual({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
      });
    });

    it('returns defaults for invalid values', () => {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 999, // Invalid
        theme: 'invalid', // Invalid
        thumbnailQuality: 'ultra', // Invalid
        autoSync: 'yes', // Invalid (not boolean)
      });

      const settings = getSettings();

      expect(settings).toEqual({
        idleTimeout: 30,
        theme: 'dark',
        thumbnailQuality: 'medium',
        autoSync: true,
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
      };

      saveSettings(settings);

      expect(localStorageMock['mosaic:settings']).toBe(JSON.stringify(settings));
    });

    it('validates and normalizes settings before saving', () => {
      const invalidSettings = {
        idleTimeout: 999,
        theme: 'invalid',
        thumbnailQuality: 'ultra',
        autoSync: 'yes',
      } as unknown as UserSettings;

      saveSettings(invalidSettings);

      const saved = JSON.parse(localStorageMock['mosaic:settings']);
      expect(saved.idleTimeout).toBe(30);
      expect(saved.theme).toBe('dark');
      expect(saved.thumbnailQuality).toBe('medium');
      expect(saved.autoSync).toBe(true);
    });

    it('notifies subscribers when settings are saved', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToSettings(callback);

      saveSettings({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: true,
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
      });

      updateSettings({ idleTimeout: 60 });

      const settings = getSettings();
      expect(settings.idleTimeout).toBe(60);
      expect(settings.theme).toBe('dark');
      expect(settings.thumbnailQuality).toBe('medium');
      expect(settings.autoSync).toBe(true);
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
      });

      expect(getSetting('idleTimeout')).toBe(60);
      expect(getSetting('theme')).toBe('light');
      expect(getSetting('thumbnailQuality')).toBe('high');
      expect(getSetting('autoSync')).toBe(false);
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
});
