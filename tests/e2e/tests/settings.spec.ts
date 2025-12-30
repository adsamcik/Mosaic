/**
 * Settings E2E Tests
 *
 * Tests the settings page functionality including theme switching,
 * session timeouts, thumbnail quality, language switching, and data management.
 *
 * Test IDs: P1-SETTINGS-1 through P1-SETTINGS-14
 */

import { test, expect } from '../fixtures';
import { LoginPage, AppShell, SettingsPage } from '../page-objects';
import { TEST_CONSTANTS } from '../fixtures';

test.describe('Settings Page @p2 @ui', () => {
  let loginPage: LoginPage;
  let appShell: AppShell;
  let settingsPage: SettingsPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    appShell = new AppShell(page);
    settingsPage = new SettingsPage(page);

    // Login
    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();
  });

  test('P1-SETTINGS-1: settings page is accessible after login', async ({ page }) => {
    // Verify settings sections are visible
    await expect(page.getByTestId('account-section')).toBeVisible();
    await expect(page.getByTestId('session-section')).toBeVisible();
    await expect(page.getByTestId('security-section')).toBeVisible();
  });

  test('P1-SETTINGS-2: can change theme setting', async ({ page }) => {
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
    await page.waitForTimeout(500); // Allow for theme transition
    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveAttribute('data-theme', newTheme);
  });

  test('P1-SETTINGS-3: can change idle timeout setting', async ({ page }) => {
    const idleTimeoutSelect = page.getByTestId('idle-timeout-select');
    await expect(idleTimeoutSelect).toBeVisible();

    // Change to a different timeout value
    await idleTimeoutSelect.selectOption('30'); // 30 minutes

    // Verify the selection changed
    await expect(idleTimeoutSelect).toHaveValue('30');
  });

  test('P1-SETTINGS-4: can change key cache duration', async ({ page }) => {
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

  test('P1-SETTINGS-5: can change thumbnail quality setting', async ({ page }) => {
    const qualitySelect = page.getByTestId('thumbnail-quality-select');
    await expect(qualitySelect).toBeVisible();

    // Change quality
    await qualitySelect.selectOption('high');
    await expect(qualitySelect).toHaveValue('high');

    // Change back to medium
    await qualitySelect.selectOption('medium');
    await expect(qualitySelect).toHaveValue('medium');
  });

  test('P1-SETTINGS-6: can toggle auto-sync setting', async ({ page }) => {
    const autoSyncToggle = page.getByTestId('auto-sync-toggle');
    await expect(autoSyncToggle).toBeVisible();

    // Get initial state
    const isChecked = await autoSyncToggle.isChecked();

    // Toggle
    await autoSyncToggle.click();

    // Verify state changed
    await expect(autoSyncToggle).toBeChecked({ checked: !isChecked });

    // Toggle back
    await autoSyncToggle.click();
    await expect(autoSyncToggle).toBeChecked({ checked: isChecked });
  });

  test('P1-SETTINGS-7: storage usage is displayed', async ({ page }) => {
    // Storage section should show usage information
    const storageSection = page.getByTestId('storage-section');
    await expect(storageSection).toBeVisible();

    // Storage bar should be visible
    const storageBar = page.getByTestId('storage-bar-fill');
    await expect(storageBar).toBeVisible();

    // Should show some storage text
    const storageText = storageSection.locator('.storage-info, .storage-text').first();
    if (await storageText.isVisible()) {
      const text = await storageText.textContent();
      expect(text).toMatch(/\d+.*(?:KB|MB|GB|bytes)/i);
    }
  });

  test('P1-SETTINGS-8: about section shows version information', async ({ page }) => {
    const aboutSection = page.getByTestId('about-section');
    await expect(aboutSection).toBeVisible();

    // Should contain version information
    const versionText = await aboutSection.textContent();
    expect(versionText).toMatch(/version|v\d+\.\d+/i);
  });
});

test.describe('Clear Data Functionality', () => {
  test('P1-SETTINGS-9: clear data requires confirmation', async ({ page }) => {
    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();
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
  test('P1-SETTINGS-11: theme preference persists after logout/login', async ({ authenticatedPage, testUser }) => {
    const loginPage = new LoginPage(authenticatedPage);
    const appShell = new AppShell(authenticatedPage);
    const settingsPage = new SettingsPage(authenticatedPage);

    await authenticatedPage.goto('/');
    await loginPage.waitForForm();
    await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Set theme to dark
    const themeSelect = authenticatedPage.getByTestId('theme-select');
    await themeSelect.selectOption('dark');
    await expect(themeSelect).toHaveValue('dark');

    // Go back to album list
    await appShell.goBack();
    await appShell.waitForLoad();

    // Logout
    await appShell.logout();
    await loginPage.waitForForm();

    // Login again
    await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    // Go to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Theme should still be dark
    await expect(authenticatedPage.getByTestId('theme-select')).toHaveValue('dark');
  });
});

test.describe('Language Settings @p1 @ui', () => {
  let loginPage: LoginPage;
  let appShell: AppShell;
  let settingsPage: SettingsPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    appShell = new AppShell(page);
    settingsPage = new SettingsPage(page);

    // Login
    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();
  });

  test('P1-SETTINGS-12: language selector is visible and functional', async ({ page }) => {
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

  test('P1-SETTINGS-13: can switch language to Czech', async ({ page }) => {
    const languageSelect = page.getByTestId('language-select');
    
    // Get initial language
    const initialLang = await languageSelect.inputValue();
    expect(['en', 'cs']).toContain(initialLang);

    // Switch to Czech
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');

    // Wait for UI to update
    await page.waitForTimeout(500);

    // Verify some text changed to Czech (check settings title or section headers)
    // The settings page title should now be in Czech
    const settingsTitle = page.locator('.settings-title');
    const titleText = await settingsTitle.textContent();
    
    // "Settings" in Czech is "Nastavení"
    expect(titleText).toBe('Nastavení');
  });

  test('P1-SETTINGS-14: can switch language back to English', async ({ page }) => {
    const languageSelect = page.getByTestId('language-select');

    // First switch to Czech
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');
    await page.waitForTimeout(300);

    // Then switch back to English
    await languageSelect.selectOption('en');
    await expect(languageSelect).toHaveValue('en');
    await page.waitForTimeout(300);

    // Verify UI is in English
    const settingsTitle = page.locator('.settings-title');
    const titleText = await settingsTitle.textContent();
    expect(titleText).toBe('Settings');
  });

  test('P1-SETTINGS-15: language preference persists after page reload', async ({ page }) => {
    const languageSelect = page.getByTestId('language-select');

    // Switch to Czech
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');
    await page.waitForTimeout(300);

    // Reload the page
    await page.reload();
    
    // Wait for settings page to load again
    await settingsPage.waitForLoad();

    // Language should still be Czech
    await expect(page.getByTestId('language-select')).toHaveValue('cs');

    // Verify UI is still in Czech
    const settingsTitle = page.locator('.settings-title');
    await expect(settingsTitle).toHaveText('Nastavení');
  });

  test('P1-SETTINGS-16: language preference persists after logout/login', async ({ authenticatedPage, testUser }) => {
    const loginPage = new LoginPage(authenticatedPage);
    const appShell = new AppShell(authenticatedPage);
    const settingsPage = new SettingsPage(authenticatedPage);

    await authenticatedPage.goto('/');
    await loginPage.waitForForm();
    await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Switch to Czech
    const languageSelect = authenticatedPage.getByTestId('language-select');
    await languageSelect.selectOption('cs');
    await expect(languageSelect).toHaveValue('cs');
    await authenticatedPage.waitForTimeout(300);

    // Go back and logout
    await appShell.goBack();
    await appShell.waitForLoad();
    await appShell.logout();
    await loginPage.waitForForm();

    // Login again
    await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    // Go to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Language should still be Czech
    await expect(authenticatedPage.getByTestId('language-select')).toHaveValue('cs');

    // Reset to English for other tests
    await authenticatedPage.getByTestId('language-select').selectOption('en');
  });
});

test.describe('Language Detection @p2 @ui', () => {
  test('P2-SETTINGS-17: detects browser locale on first visit', async ({ browser }) => {
    // Create a new context with Czech locale
    const context = await browser.newContext({
      locale: 'cs-CZ',
    });
    const page = await context.newPage();

    // Clear any existing language preference
    await page.addInitScript(() => {
      localStorage.removeItem('mosaic-language');
    });

    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    // Navigate to app
    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Language should be detected as Czech based on browser locale
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toHaveValue('cs');

    await context.close();
  });

  test('P2-SETTINGS-18: falls back to English for unsupported locale', async ({ browser }) => {
    // Create a new context with an unsupported locale (German)
    const context = await browser.newContext({
      locale: 'de-DE',
    });
    const page = await context.newPage();

    // Clear any existing language preference
    await page.addInitScript(() => {
      localStorage.removeItem('mosaic-language');
    });

    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    // Navigate to app
    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();

    // Navigate to settings
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Language should fall back to English
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toHaveValue('en');

    await context.close();
  });

  test('P2-SETTINGS-19: manual selection overrides browser locale', async ({ browser }) => {
    // Create a new context with Czech locale
    const context = await browser.newContext({
      locale: 'cs-CZ',
    });
    const page = await context.newPage();

    // Clear any existing language preference
    await page.addInitScript(() => {
      localStorage.removeItem('mosaic-language');
    });

    const loginPage = new LoginPage(page);
    const appShell = new AppShell(page);
    const settingsPage = new SettingsPage(page);

    // Navigate and login
    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();
    await appShell.openSettings();
    await settingsPage.waitForLoad();

    // Initially should be Czech from locale
    const languageSelect = page.getByTestId('language-select');
    await expect(languageSelect).toHaveValue('cs');

    // Manually switch to English
    await languageSelect.selectOption('en');
    await expect(languageSelect).toHaveValue('en');
    await page.waitForTimeout(300);

    // Reload page
    await page.reload();
    await settingsPage.waitForLoad();

    // Should remain English (manual preference overrides locale)
    await expect(page.getByTestId('language-select')).toHaveValue('en');

    await context.close();
  });
});
