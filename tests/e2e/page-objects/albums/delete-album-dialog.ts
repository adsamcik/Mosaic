/**
 * Delete Album Dialog Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class DeleteAlbumDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;
  readonly albumInfo: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('delete-album-dialog');
    this.confirmButton = page.getByTestId('delete-album-confirm-button');
    this.cancelButton = page.getByTestId('delete-album-cancel-button');
    this.albumInfo = page.getByTestId('delete-album-info');
    this.errorMessage = page.getByTestId('delete-album-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async confirm(): Promise<void> {
    await this.confirmButton.click();
  }

  async confirmAndWaitForClose(timeout = 30000): Promise<void> {
    await this.confirmButton.click();
    await this.waitForClose(timeout);
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectAlbumInfo(albumName: string): Promise<void> {
    await expect(this.albumInfo).toContainText(albumName);
  }
}
