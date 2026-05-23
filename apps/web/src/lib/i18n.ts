import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from '../locales/en.json';
import cs from '../locales/cs.json';

export const supportedLanguages = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number]['code'];

// BCP-47 RTL language subtags (preparation for future v1.1 RTL locales).
// Until a code from this set is added to supportedLanguages above, all
// runtime behaviour is unchanged (every shipped locale is LTR).
const RTL_LANGUAGE_CODES = new Set([
  'ar', 'arc', 'dv', 'fa', 'ha', 'he', 'khw', 'ks', 'ku', 'ps', 'ur', 'yi',
]);

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      cs: { translation: cs },
    },
    fallbackLng: 'en',
    supportedLngs: supportedLanguages.map((l) => l.code),
    nonExplicitSupportedLngs: true, // Allow cs-CZ to match cs

    interpolation: {
      escapeValue: false, // React already escapes values
    },

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'mosaic-language',
    },

    react: {
      useSuspense: false, // Prevent suspense boundary issues
    },
  });

function syncDocumentLanguage(lang: string | undefined): void {
  if (typeof document === 'undefined' || !lang) {
    return;
  }

  const base = lang.split('-')[0] || 'en';
  document.documentElement.lang = base;
  document.documentElement.dir = RTL_LANGUAGE_CODES.has(base) ? 'rtl' : 'ltr';
}

i18n.on('languageChanged', syncDocumentLanguage);
syncDocumentLanguage(i18n.language);

export default i18n;

/**
 * Change the application language
 */
export function changeLanguage(lang: SupportedLanguage): Promise<void> {
  return i18n.changeLanguage(lang).then(() => {
    syncDocumentLanguage(lang);
    localStorage.setItem('mosaic-language', lang);
  });
}

/**
 * Get the current language
 */
export function getCurrentLanguage(): SupportedLanguage {
  return (i18n.language?.split('-')[0] as SupportedLanguage) || 'en';
}
