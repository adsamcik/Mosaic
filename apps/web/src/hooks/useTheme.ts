/**
 * Theme Hook
 *
 * Manages theme preference and applies it to the document.
 * Supports dark, light, and system themes.
 */

import { useEffect, useState } from 'react';
import {
  getSettings,
  subscribeToSettings,
  type Theme,
} from '../lib/settings-service';

/**
 * Get the effective theme based on user preference and system setting.
 */
function getEffectiveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return theme;
}

/**
 * Apply theme to the document element.
 */
function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Hook that manages theme preference and applies it to the document.
 * Automatically responds to:
 * - User settings changes
 * - System theme preference changes (when set to 'system')
 *
 * @returns The current effective theme ('dark' | 'light')
 */
export function useTheme(): 'dark' | 'light' {
  const [effectiveTheme, setEffectiveTheme] = useState<'dark' | 'light'>(() => {
    const settings = getSettings();
    return getEffectiveTheme(settings.theme);
  });

  useEffect(() => {
    // Apply initial theme
    const settings = getSettings();
    const theme = getEffectiveTheme(settings.theme);
    setEffectiveTheme(theme);
    applyTheme(theme);

    // Subscribe to settings changes
    const unsubscribeSettings = subscribeToSettings((newSettings) => {
      const newTheme = getEffectiveTheme(newSettings.theme);
      setEffectiveTheme(newTheme);
      applyTheme(newTheme);
    });

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = () => {
      const currentSettings = getSettings();
      if (currentSettings.theme === 'system') {
        const newTheme = getEffectiveTheme('system');
        setEffectiveTheme(newTheme);
        applyTheme(newTheme);
      }
    };

    mediaQuery.addEventListener('change', handleSystemChange);

    return () => {
      unsubscribeSettings();
      mediaQuery.removeEventListener('change', handleSystemChange);
    };
  }, []);

  return effectiveTheme;
}
