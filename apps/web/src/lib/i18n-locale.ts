import i18next from 'i18next';
import i18n from './i18n';

/**
 * Returns the active i18n locale, preferring resolvedLanguage so that locale
 * fallback (en → cs) reflects what's actually being rendered. Falls back to
 * 'en' if neither is set.
 *
 * Use this with Intl.DateTimeFormat, Intl.NumberFormat, and the
 * toLocale*String methods to ensure date/time/number formatting matches the
 * app's chosen language rather than the browser's navigator.language.
 */
export function getActiveLocale(): string {
  return i18next.resolvedLanguage ?? i18next.language ?? i18n.resolvedLanguage ?? i18n.language ?? 'en';
}
