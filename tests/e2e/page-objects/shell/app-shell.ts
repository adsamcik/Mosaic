/**
 * App Shell Page Object
 */

import { type Page, type Locator, expect } from '../base';

export class AppShell {
  readonly page: Page;
  readonly shell: Locator;
  readonly albumList: Locator;
  readonly createAlbumButton: Locator;
  readonly logoutButton: Locator;
  readonly settingsButton: Locator;
  readonly adminButton: Locator;
  readonly backButton: Locator;
  readonly backToAlbumsButton: Locator; // Alias for backButton for backward compatibility
  readonly searchInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shell = page.getByTestId('app-shell');
    this.albumList = page.getByTestId('album-list');
    // EN: "Create Album" / CS: "Vytvořit album"
    this.createAlbumButton = page.getByRole('button', { name: /create album|new album|vytvořit album|\+/i });
    // Use class selector to avoid matching photo elements with similar text
    this.logoutButton = page.locator('button.logout-button');
    this.settingsButton = page.getByTestId('settings-nav-button');
    // EN: "Admin" / CS: "Administrace" (but icon-based via testid would be more reliable)
    this.adminButton = page.getByRole('button', { name: /admin|shield|administrace/i });
    // EN: "Back" / CS: "Zpět"
    this.backButton = page.getByRole('button', { name: /back|albums|zpět|alba/i });
    this.backToAlbumsButton = this.backButton; // Alias for backward compatibility
    this.searchInput = page.getByTestId('search-input');
  }

  async waitForLoad(timeout = 30000): Promise<void> {
    await expect(this.shell).toBeVisible({ timeout });
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
  }

  /**
   * Open the create album dialog
   */
  async openCreateAlbumDialog(): Promise<void> {
    await this.createAlbumButton.click();
  }

  /**
   * Alias for openCreateAlbumDialog() for backward compatibility
   */
  async createAlbum(): Promise<void> {
    await this.createAlbumButton.click();
  }

  async openSettings(): Promise<void> {
    await this.settingsButton.click();
  }

  async openAdmin(): Promise<void> {
    await this.adminButton.click();
  }

  async goBack(): Promise<void> {
    await this.backButton.click();
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }

  async getAlbumCards(): Promise<Locator[]> {
    return this.page.getByTestId('album-card').all();
  }

  async clickAlbum(index: number): Promise<void> {
    const cards = await this.getAlbumCards();
    if (cards[index]) {
      await cards[index].click();
    } else {
      throw new Error(`Album at index ${index} not found`);
    }
  }

  async clickAlbumByName(name: string): Promise<void> {
    await this.page.getByTestId('album-card').filter({ hasText: name }).click();
  }

  async expectAlbumCount(count: number): Promise<void> {
    await expect(this.page.getByTestId('album-card')).toHaveCount(count, { timeout: 10000 });
  }

  /**
   * Wait for album list to be visible
   */
  async expectAlbumListVisible(): Promise<void> {
    await expect(this.albumList).toBeVisible({ timeout: 10000 });
  }

  async expectEmptyState(): Promise<void> {
    const emptyMessage = this.page.getByText(/no albums|create.*album|get started/i);
    await expect(emptyMessage.first()).toBeVisible({ timeout: 10000 });
  }
}
