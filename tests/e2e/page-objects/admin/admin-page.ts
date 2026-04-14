/**
 * Admin Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class AdminPage {
  readonly page: Page;
  readonly container: Locator;
  readonly dashboardTab: Locator;
  readonly usersTab: Locator;
  readonly albumsTab: Locator;
  readonly settingsTab: Locator;
  readonly userTable: Locator;
  readonly albumTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('admin-page');
    this.dashboardTab = page.getByRole('tab', { name: /dashboard/i });
    this.usersTab = page.getByRole('tab', { name: /users/i });
    this.albumsTab = page.getByRole('tab', { name: /albums/i });
    this.settingsTab = page.getByRole('tab', { name: /settings/i });
    this.userTable = page.getByTestId('users-table');
    this.albumTable = page.getByTestId('albums-table');
  }

  async waitForLoad(timeout = 60000): Promise<void> {
    // Wait for admin-page container (present in loading/error/loaded states)
    await expect(this.container).toBeVisible({ timeout });

    // Admin data comes from 5 parallel API calls — in CI Docker these can
    // be slow or fail transiently.  Detect the error state (Retry button)
    // and automatically retry up to 2 times before giving up.
    const retryButton = this.container.getByRole('button', { name: 'Retry' });
    const perAttemptTimeout = Math.floor(timeout / 3);
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await Promise.race([
        this.dashboardTab
          .waitFor({ state: 'visible', timeout: perAttemptTimeout })
          .then(() => 'loaded' as const),
        retryButton
          .waitFor({ state: 'visible', timeout: perAttemptTimeout })
          .then(() => 'error' as const),
      ]).catch(() => 'timeout' as const);

      if (result === 'loaded') {
        return;
      }

      if (result === 'error' && attempt < maxRetries) {
        await retryButton.click();
        // Wait for loading to restart before the next attempt
        await expect(retryButton).toBeHidden({ timeout: 5000 });
        continue;
      }

      break;
    }

    // Final assertion — gives a clear error message on failure
    await expect(this.dashboardTab).toBeVisible({ timeout: 10000 });
  }

  async openDashboard(): Promise<void> {
    await this.dashboardTab.click();
  }

  async openUsers(): Promise<void> {
    await this.usersTab.click();
    await expect(this.userTable).toBeVisible({ timeout: 10000 });
  }

  async openAlbums(): Promise<void> {
    await this.albumsTab.click();
    await expect(this.albumTable).toBeVisible({ timeout: 10000 });
  }

  async openSettings(): Promise<void> {
    await this.settingsTab.click();
  }

  async getUserRows(): Promise<Locator[]> {
    return this.userTable.locator('tr').all();
  }

  async getAlbumRows(): Promise<Locator[]> {
    return this.albumTable.locator('tr').all();
  }
}
