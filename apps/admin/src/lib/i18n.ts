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

export default i18n;

/**
 * Change the application language
 */
export function changeLanguage(lang: SupportedLanguage): Promise<void> {
  return i18n.changeLanguage(lang).then(() => {
    localStorage.setItem('mosaic-language', lang);
  });
}

/**
 * Get the current language
 */
export function getCurrentLanguage(): SupportedLanguage {
  return (i18n.language?.split('-')[0] as SupportedLanguage) || 'en';
}
