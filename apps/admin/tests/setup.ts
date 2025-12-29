/**
 * Vitest setup file for React 19 testing with Happy-DOM
 *
 * This file runs before each test file and configures the global environment
 * for React's act() function to work correctly.
 */

import { vi } from 'vitest';

// Tell React we're in a test environment where act() is expected
// This is required for React 19 to use act() without warnings/errors
// @ts-expect-error - React internal flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Mock react-i18next to return translation keys as-is for testing
// This allows tests to verify the correct keys are being used
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      // If params provided, append them for test visibility
      if (params && Object.keys(params).length > 0) {
        return `${key}:${JSON.stringify(params)}`;
      }
      return key;
    },
    i18n: {
      language: 'en',
      changeLanguage: vi.fn(),
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
}));
