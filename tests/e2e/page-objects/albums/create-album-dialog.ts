/**
 * Create Album Dialog Page Object
 */

import { type Page, type Locator, expect } from '../base';

export class CreateAlbumDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly nameInput: Locator;
  readonly createButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('create-album-dialog');
    this.nameInput = page.getByTestId('album-name-input');
    this.createButton = page.getByTestId('create-button');
    this.cancelButton = page.getByTestId('cancel-button');
    this.errorMessage = page.getByTestId('create-album-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  /**
   * Alias for waitForOpen for backward compatibility
   */
  async waitForDialog(timeout = 10000): Promise<void> {
    await this.waitForOpen(timeout);
  }

  async waitForClose(timeout = 30000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setName(name: string): Promise<void> {
    await this.nameInput.fill(name);
  }

  /**
   * Alias for setName for backward compatibility
   */
  async fillName(name: string): Promise<void> {
    await this.setName(name);
  }

  async submit(): Promise<void> {
    await this.createButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  async createAlbum(name: string): Promise<void> {
    await this.waitForOpen();
    await this.setName(name);
    await this.submit();
    await this.waitForClose();
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }
}
