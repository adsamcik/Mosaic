import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveLocale } from '../i18n-locale';

const mockI18n = vi.hoisted(() => ({
  resolvedLanguage: undefined as string | undefined,
  language: undefined as string | undefined,
}));

vi.mock('../i18n', () => ({
  default: mockI18n,
}));

describe('getActiveLocale', () => {
  beforeEach(() => {
    mockI18n.resolvedLanguage = undefined;
    mockI18n.language = undefined;
  });

  it('returns resolvedLanguage when set', () => {
    mockI18n.resolvedLanguage = 'cs';
    mockI18n.language = 'en';

    expect(getActiveLocale()).toBe('cs');
  });

  it('falls back to language when resolvedLanguage is undefined', () => {
    mockI18n.language = 'cs-CZ';

    expect(getActiveLocale()).toBe('cs-CZ');
  });

  it('falls back to en when neither is set', () => {
    expect(getActiveLocale()).toBe('en');
  });
});
