/**
 * Settings E2E Tests
 *
 * Tests the settings page functionality including theme switching,
 * session timeouts, thumbnail quality, language switching, and data management.
 *
 * Test IDs: P1-SETTINGS-1 through P1-SETTINGS-14
 */

import { test, expect, LoginPage, AppShell, SettingsPage, TEST_CONSTANTS } from '../fixtures-enhanced';

test.describe('Settings Page @p2 @ui', () => {
  test.beforeEach(async ({ loggedInPage }) => {
    const appShell = new AppShell(loggedInPage);
    const settingsPage = new SettingsPage(loggedInPage);

    // Navigate to settings (loggedInPage is already authenticated)
    await appShell.openSettings();
    await settingsPage.waitForLoad();
  });

  test('P1-SETTINGS-1: settings page is accessible after login', async ({ loggedInPage: page }) => {
    // Verify settings sections are visible
    await expect(page.getByTestId('account-section')).toBeVisible();
    await expect(page.getByTestId('session-section')).toBeVisible();
    await expect(page.getByTestId('security-section')).toBeVisible();
  });

  test('P1-SETTINGS-2: can change theme setting', async ({ loggedInPage: page }) => {
    const themeSelect = page.getByTestId('theme-select');
    await expect(themeSelect).toBeVisible();

    // Get initial theme
    const initialTheme = await themeSelect.inputValue();

    // Change to a different theme
    const newTheme = initialTheme === 'dark' ? 'light' : 'dark';
    await themeSelect.selectOption(newTheme);

    // Verify the selection changed
    await expect(themeSelect).toHaveValue(newTheme);

    // Verify theme is applied to document (check for theme class on html/body)
    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveAttribute('data-theme', newTheme, { timeout: 2000 });
  });

  test('P1-SETTINGS-3: can change idle timeout setting', async ({ loggedInPage: page }) => {
    const idleTimeoutSelect = page.getByTestId('idle-timeout-select');
    await expect(idleTimeoutSelect).toBeVisible();

    // Change to a different timeout value
    await idleTimeoutSelect.selectOption('30'); // 30 minutes

    // Verify the selection changed
    await expect(idleTimeoutSelect).toHaveValue('30');
  });

  test('P1-SETTINGS-4: can change key cache duration', async ({ loggedInPage: page }) => {
    const keyCacheSelect = page.getByTestId('key-cache-duration-select');
    await expect(keyCacheSelect).toBeVisible();

    // Get available options
    const options = await keyCacheSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);

    // Select a different option if available
    if (options.length > 1) {
      await keyCacheSelect.selectOption({ index: 1 });
    }
  });

  test('P1-SETTINGS-5: can change thumbnail quality setting', async ({ loggedInPage: page }) => {
    const qualitySelect = page.getByTestId('thumbnail-quality-select');
    await expect(qualitySelect).toBeVisible();

    // Change quality
    await qualitySelect.selectOption('high');
    await expect(qualitySelect).toHaveValue('high');

    // Change back to medium
    await qualitySelect.selectOption('medium');
    await expect(qualitySelect).toHaveValue('medium');
  });

  test('P1-SETTINGS-6: can toggle auto-sync setting', async ({ loggedInPage: page }) => {
    const autoSyncToggle = page.getByTestId('auto-sync-toggle');
    const autoSyncSwitch = page.locator('label.toggle-switch').filter({ has: autoSyncToggle });
    await expect(autoSyncToggle).toBeAttached();
    await expect(autoSyncSwitch).toBeVisible();

    // Get initial state
    const isChecked = await autoSyncToggle.isChecked();

    // Toggle
    await autoSyncSwitch.click();

    // Verify state changed
    await expect(autoSyncToggle).toBeChecked({ checked: !isChecked });

    // Toggle back
    await autoSyncSwitch.click();
    await expect(autoSyncToggle).toBeChecked({ checked: isChecked });
  });

  test('P1-SETTINGS-7: storage usage is displayed', async ({ loggedInPage: page }) => {
    // Storage section should show usage information
    const storageSection = page.getByTestId('storage-section');
    await expect(storageSection).toBeVisible();

    // Storage bar fill element should exist (may be 0 width if no storage used)
    const storageBar = page.getByTestId('storage-bar-fill');
    await expect(storageBar).toBeAttached();

    // Should show some storage text (e.g., "0 B used" or "10 MB used")
    const storageText = storageSection.locator('.storage-info, .storage-text').first();
    if (await storageText.isVisible()) {
      const text = await storageText.textContent();
      expect(text).toMatch(/\d+.*(?:KB|MB|GB|bytes|B)/i);
    }
  });

  test('P1-SETTINGS-8: about section shows version information', async ({ loggedInPage: page }) => {
    const aboutSection = page.getByTestId('about-section');
    await expect(aboutSection).toBeVisible();

    // Should contain version information
    const versionText = await aboutSection.textContent();
    expect(versionText).toMatch(/version|v\d+\.\d+/i);
  });
});

test.describe('Clear Data Functionality', () => {
  test('P1-SETTINGS-9: clear data requires confirmation', async ({ loggedInPage: page }) => {
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Click clear data button
    const clearButton = page.getByTestId('clear-data-button');
    await expect(clearButton).toBeVisible();
    await clearButton.click();

    // Confirmation dialog should appear
    const confirmDialog = page.getByTestId('clear-confirm-dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    // Cancel button should close dialog without action
    const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
    await cancelButton.click();
    await expect(confirmDialog).toBeHidden();
  });

  test.skip('P2-SETTINGS-10: confirming clear data removes local storage', async ({ page }) => {
    // This test is skipped because it destroys the local database
    // and would require re-setup for subsequent tests.
    // It should be run in isolation if needed.
  });
});

test.describe('Settings Persistence', () => {
  test('P1-SETTINGS-11: theme preference persists after logout/login', async ({ browser, testUser }) => {
    // Create a fresh context for this test
    const context = await browser.newContext();
    const page = await context.newPage();
    
    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    await page.goto('/');
    await loginPage.waitForForm();
    
    // Register the user (first time login in LocalAuth mode)
    await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Set theme to dark
    const themeSelect = page.getByTestId('theme-select');
    await themeSelect.selectOption('dark');
    await expect(themeSelect).toHaveValue('dark');

    // Go back to album list
    await appShell.goBack();
    await appShell.waitForLoad();

    // Logout
    await appShell.logout();
    await loginPage.waitForForm();

    // Login again (user now exists)
    await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    // Go to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Theme should still be dark
    await expect(page.getByTestId('theme-select')).toHaveValue('dark');
    
    await context.close();
  });
});

test.describe('Language Settings @p1 @ui', () => {
  test.beforeEach(async ({ loggedInPage }) => {
    const appShell = new AppShell(loggedInPage);
    const settingsPage = new SettingsPage(loggedInPage);

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();
  });

  test('P1-SETTINGS-12: language selector is visible and functional', async ({ loggedInPage: page }) => {
    // Language select should be visible
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toBeVisible();

    // Should have at least English and Czech options
    const options = await languageSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(2);
    
    // Verify English and Czech are available
    const optionValues = await languageSelect.locator('option').evaluateAll(
      (opts: HTMLOptionElement[]) => opts.map(o => o.value)
    );
    expect(optionValues).toContain('en');
    expect(optionValues).toContain('cs');
  });

  test('P1-SETTINGS-13: can switch language to Czech', async ({ loggedInPage: page }) => {
    const languageSelect = page.getByTestId('language-select');
    
    // Get initial language
    const initialLang = await languageSelect.inputValue();
    expect(['en', 'cs']).toContain(initialLang);

    // Switch to Czech
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');

    // Verify some text changed to Czech (check settings title or section headers)
    // The settings page title should now be in Czech - wait for it to update
    const settingsTitle = page.locator('.settings-title');
    await expect(settingsTitle).toHaveText('Nastavení', { timeout: 2000 });
  });

  test('P1-SETTINGS-14: can switch language back to English', async ({ loggedInPage: page }) => {
    const languageSelect = page.getByTestId('language-select');

    // First switch to Czech
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');
    // Wait for Czech title to confirm language change applied
    await expect(page.locator('.settings-title')).toHaveText('Nastavení', { timeout: 2000 });

    // Then switch back to English
    await languageSelect.selectOption('en');
    await expect(languageSelect).toHaveValue('en');

    // Verify UI is in English
    const settingsTitle = page.locator('.settings-title');
    await expect(settingsTitle).toHaveText('Settings', { timeout: 2000 });
  });

  test('P1-SETTINGS-15: language preference persists after page reload', async ({ loggedInPage: page, testUser }) => {
    const settingsPage = new SettingsPage(page);
    const languageSelect = page.getByTestId('language-select');

    // Switch to Czech
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');
    // Wait for Czech title to confirm language change applied
    await expect(page.locator('.settings-title')).toHaveText('Nastavení', { timeout: 2000 });

    // Reload the page
    await page.reload();
    const loginPage = new LoginPage(page);
    await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);
    
    // Wait for settings page to load again
    await settingsPage.waitForLoad();

    // Language should still be Czech
    await expect(page.getByTestId('language-select')).toHaveValue('cs');

    // Verify UI is still in Czech
    const settingsTitle = page.locator('.settings-title');
    await expect(settingsTitle).toHaveText('Nastavení');
  });

  // This test verifies language persists across logout/login cycle
  // Using loggedInPage fixture for reliable authentication
  test('P1-SETTINGS-16: language preference persists after logout/login', async ({ loggedInPage, testUser }) => {
    const page = loggedInPage;
    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);
    
    // We're already on Settings (beforeEach navigates there)

    // Switch to Czech
    const languageSelect = page.getByTestId('language-select');
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');
    
    // Wait for UI to update to Czech (confirms language change was applied)
    await expect(page.getByRole('heading', { name: 'Jazyk' })).toBeVisible({ timeout: 5000 });
    
    // Verify localStorage was updated
    const savedLang = await page.evaluate(() => localStorage.getItem('mosaic-language'));
    expect(savedLang).toBe('cs');

    // Go back and logout  
    await appShell.goBack();
    await appShell.waitForLoad();
    await appShell.logout();
    await loginPage.waitForForm();

    // Verify localStorage persists after logout (language should still be Czech in localStorage)
    const langAfterLogout = await page.evaluate(() => localStorage.getItem('mosaic-language'));
    expect(langAfterLogout).toBe('cs');

    // Login again (user already exists now) - wait for form to be ready first
    await expect(page.getByRole('button', { name: /login|přihlásit/i })).toBeEnabled({ timeout: 2000 });
    
    // Check if LocalAuth mode 
    const usernameInput = page.getByLabel(/username|uživatelské jméno/i);
    const isLocalAuth = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth) {
      await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
    } else {
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
    }
    await loginPage.expectLoginSuccess();

    // Go to settings - UI should be in Czech
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Language should still be Czech (persisted in localStorage)
    await expect(page.getByTestId('language-select')).toHaveValue('cs');
    
    // Verify UI is in Czech by checking a translated heading
    await expect(page.getByRole('heading', { name: 'Jazyk' })).toBeVisible();

    // Reset to English for other tests
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Language Detection @p2 @ui', () => {
  test('P2-SETTINGS-17: detects browser locale on first visit', async ({ browser, testUser }) => {
    // Create a new context with Czech locale
    const context = await browser.newContext({
      locale: 'cs-CZ',
      storageState: undefined, // Ensure clean state
    });
    const page = await context.newPage();

    // Inject auth headers for API calls (for ProxyAuth mode support)
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    // Navigate to app - this is the first visit so no language should be cached
    await loginPage.goto();
    
    // Clear any language preference that might have been set during page load
    await page.evaluate(() => localStorage.removeItem('mosaic-language'));
    
    // Reload to trigger fresh language detection
    await page.reload();
    await loginPage.waitForForm();

    // Check if LocalAuth mode - look for username field (in English or Czech)
    // The field may be in Czech ("Uživatelské jméno") if locale detection worked
    const usernameInputEn = page.getByLabel('Username');
    const usernameInputCs = page.getByLabel('Uživatelské jméno');
    const isLocalAuthEn = await usernameInputEn.isVisible({ timeout: 1000 }).catch(() => false);
    const isLocalAuthCs = await usernameInputCs.isVisible({ timeout: 1000 }).catch(() => false);
    const isLocalAuth = isLocalAuthEn || isLocalAuthCs;
    
    if (isLocalAuth) {
      await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
    } else {
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
    }
    await loginPage.expectLoginSuccess();

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Language should be detected as Czech based on browser locale
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toHaveValue('cs');

    await context.close();
  });

  test('P2-SETTINGS-18: falls back to English for unsupported locale', async ({ browser, testUser }) => {
    // Create a new context with an unsupported locale (German)
    const context = await browser.newContext({
      locale: 'de-DE',
      storageState: undefined, // Ensure clean state
    });
    const page = await context.newPage();

    // Inject auth headers for API calls (for ProxyAuth mode support)
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    // Navigate to app - this is the first visit so no language should be cached
    await loginPage.goto();
    
    // Clear any language preference that might have been set during page load
    await page.evaluate(() => localStorage.removeItem('mosaic-language'));
    
    // Reload to trigger fresh language detection
    await page.reload();
    await loginPage.waitForForm();

    // Check if LocalAuth mode - look for username field (English since de-DE falls back to en)
    const usernameInput = page.getByLabel(/username|uživatelské jméno/i);
    const isLocalAuth = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (isLocalAuth) {
      await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
    } else {
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
    }
    await loginPage.expectLoginSuccess();

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Language should fall back to English
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toHaveValue('en');

    await context.close();
  });

  test('P2-SETTINGS-19: manual selection overrides browser locale', async ({ browser, testUser }) => {
    // Create a new context with Czech locale
    const context = await browser.newContext({
      locale: 'cs-CZ',
      storageState: undefined, // Ensure clean state
    });
    const page = await context.newPage();

    // Inject auth headers for API calls (for ProxyAuth mode support)
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    // Navigate to app - this is the first visit so no language should be cached
    await loginPage.goto();
    
    // Clear any language preference that might have been set during page load
    await page.evaluate(() => localStorage.removeItem('mosaic-language'));
    
    // Reload to trigger fresh language detection
    await page.reload();
    await loginPage.waitForForm();

    // Check if LocalAuth mode - look for username field (in English or Czech)
    const usernameInputEn = page.getByLabel('Username');
    const usernameInputCs = page.getByLabel('Uživatelské jméno');
    const isLocalAuthEn = await usernameInputEn.isVisible({ timeout: 1000 }).catch(() => false);
    const isLocalAuthCs = await usernameInputCs.isVisible({ timeout: 1000 }).catch(() => false);
    const isLocalAuth = isLocalAuthEn || isLocalAuthCs;
    
    if (isLocalAuth) {
      await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
    } else {
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
    }
    await loginPage.expectLoginSuccess();
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Initially should be Czech from locale
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toHaveValue('cs');

    // Manually switch to English
    await languageSelect.selectOption('en');
    await expect(languageSelect).toHaveValue('en');
    // Wait for English title to confirm language change applied
    await expect(page.locator('.settings-title')).toHaveText('Settings', { timeout: 2000 });

    // Reload page
    await page.reload();
    await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);
    await settingsPage.waitForLoad();

    // Should remain English (manual preference overrides locale)
    await expect(page.getByTestId('language-select')).toHaveValue('en');

    await context.close();
  });
});
