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

  async waitForLoad(): Promise<void> {
    await expect(this.container).toBeVisible({ timeout: 30000 });
    await expect(this.dashboardTab).toBeVisible({ timeout: 30000 });
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
