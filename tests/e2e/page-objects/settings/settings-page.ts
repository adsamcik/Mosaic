/**
 * Settings Page Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class SettingsPage {
  readonly page: Page;
  readonly container: Locator;
  readonly themeSelect: Locator;
  readonly autoSyncToggle: Locator;
  readonly keyCacheDurationSelect: Locator;
  readonly idleTimeoutSelect: Locator;
  readonly saveButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('settings-page');
    this.themeSelect = page.getByLabel(/theme/i);
    this.autoSyncToggle = page.getByLabel(/auto.*sync/i);
    this.keyCacheDurationSelect = page.getByLabel(/remember|cache|session/i);
    this.idleTimeoutSelect = page.getByTestId('idle-timeout-select');
    this.saveButton = page.getByRole('button', { name: /save/i });
    this.closeButton = page.getByRole('button', { name: /close|back/i });
  }

  async waitForLoad(timeout = 10000): Promise<void> {
    await expect(this.container).toBeVisible({ timeout });
  }

  async setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
    await this.themeSelect.selectOption(theme);
  }

  async setAutoSync(enabled: boolean): Promise<void> {
    const isChecked = await this.autoSyncToggle.isChecked();
    if (isChecked !== enabled) {
      await this.autoSyncToggle.click();
    }
  }

  async setKeyCacheDuration(value: string): Promise<void> {
    await this.keyCacheDurationSelect.selectOption(value);
  }

  async setIdleTimeout(minutes: '15' | '30' | '60'): Promise<void> {
    await this.idleTimeoutSelect.selectOption(minutes);
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
  }
}
