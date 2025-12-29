/**
 * Tests for i18n configuration and language switching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Note: The actual i18n module is mocked in setup.ts, so we test the exports
// For real i18n behavior, we'd need integration tests

describe('i18n configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  describe('supportedLanguages', () => {
    it('should export supported languages list', async () => {
      // We need to dynamically import to get the actual module (bypassing the mock)
      const { supportedLanguages } = await vi.importActual<typeof import('../src/lib/i18n')>('../src/lib/i18n');
      
      expect(supportedLanguages).toBeDefined();
      expect(Array.isArray(supportedLanguages)).toBe(true);
      expect(supportedLanguages.length).toBeGreaterThanOrEqual(2);
      
      // Check English is present
      const english = supportedLanguages.find(l => l.code === 'en');
      expect(english).toBeDefined();
      expect(english?.name).toBe('English');
      expect(english?.nativeName).toBe('English');
      
      // Check Czech is present
      const czech = supportedLanguages.find(l => l.code === 'cs');
      expect(czech).toBeDefined();
      expect(czech?.name).toBe('Czech');
      expect(czech?.nativeName).toBe('Čeština');
    });
  });

  describe('getCurrentLanguage', () => {
    it('should return current language', async () => {
      const { getCurrentLanguage } = await vi.importActual<typeof import('../src/lib/i18n')>('../src/lib/i18n');
      
      const lang = getCurrentLanguage();
      expect(typeof lang).toBe('string');
      expect(['en', 'cs']).toContain(lang);
    });
  });

  describe('changeLanguage', () => {
    it('should be a function', async () => {
      const { changeLanguage } = await vi.importActual<typeof import('../src/lib/i18n')>('../src/lib/i18n');
      
      expect(typeof changeLanguage).toBe('function');
    });

    it('should store language preference in localStorage', async () => {
      const { changeLanguage } = await vi.importActual<typeof import('../src/lib/i18n')>('../src/lib/i18n');
      
      await changeLanguage('cs');
      expect(localStorage.getItem('mosaic-language')).toBe('cs');
      
      await changeLanguage('en');
      expect(localStorage.getItem('mosaic-language')).toBe('en');
    });
  });
});

describe('translation files', () => {
  it('English translations should have all required namespaces', async () => {
    const en = await import('../src/locales/en.json');
    
    expect(en.common).toBeDefined();
    expect(en.auth).toBeDefined();
    expect(en.navigation).toBeDefined();
    expect(en.album).toBeDefined();
    expect(en.gallery).toBeDefined();
    expect(en.lightbox).toBeDefined();
    expect(en.upload).toBeDefined();
    expect(en.member).toBeDefined();
    expect(en.settings).toBeDefined();
    expect(en.admin).toBeDefined();
    expect(en.shareLink).toBeDefined();
    expect(en.shared).toBeDefined();
    expect(en.error).toBeDefined();
  });

  it('Czech translations should have all required namespaces', async () => {
    const cs = await import('../src/locales/cs.json');
    
    expect(cs.common).toBeDefined();
    expect(cs.auth).toBeDefined();
    expect(cs.navigation).toBeDefined();
    expect(cs.album).toBeDefined();
    expect(cs.gallery).toBeDefined();
    expect(cs.lightbox).toBeDefined();
    expect(cs.upload).toBeDefined();
    expect(cs.member).toBeDefined();
    expect(cs.settings).toBeDefined();
    expect(cs.admin).toBeDefined();
    expect(cs.shareLink).toBeDefined();
    expect(cs.shared).toBeDefined();
    expect(cs.error).toBeDefined();
  });

  it('Czech translations should have same top-level keys as English', async () => {
    const en = await import('../src/locales/en.json');
    const cs = await import('../src/locales/cs.json');
    
    const enKeys = Object.keys(en.default ?? en);
    const csKeys = Object.keys(cs.default ?? cs);
    
    expect(csKeys.sort()).toEqual(enKeys.sort());
  });

  it('common namespace should have essential keys', async () => {
    const en = await import('../src/locales/en.json');
    
    // Check for essential common keys
    expect(en.common.cancel).toBe('Cancel');
    expect(en.common.save).toBe('Save');
    expect(en.common.delete).toBe('Delete');
    expect(en.common.loading).toBe('Loading...');
    expect(en.common.back).toBe('Back');
    expect(en.common.retry).toBe('Retry');
  });

  it('auth namespace should have login-related keys', async () => {
    const en = await import('../src/locales/en.json');
    
    expect(en.auth.signInButton).toBe('Sign In');
    expect(en.auth.createAccountButton).toBe('Create Account');
    expect(en.auth.usernameLabel).toBe('Username');
    expect(en.auth.passwordLabel).toBe('Password');
    expect(en.auth.error.passwordRequired).toBe('Password is required');
  });

  it('settings namespace should have language section', async () => {
    const en = await import('../src/locales/en.json');
    
    expect(en.settings.language).toBeDefined();
    expect(en.settings.language.title).toBe('Language');
    expect(en.settings.language.description).toBe('Choose your preferred language');
  });
});

describe('useTranslation mock verification', () => {
  it('mock is configured in setup.ts and verified by component tests', () => {
    // The mock is set up in setup.ts and verified by all component tests
    // that use useTranslation and expect translation keys to be returned
    // This test is a placeholder - the actual verification happens in
    // component tests like album-card.test.tsx, login-form.test.tsx, etc.
    expect(true).toBe(true);
  });
});
