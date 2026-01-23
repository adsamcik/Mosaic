/**
 * Rename Album Dialog Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class RenameAlbumDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly nameInput: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('rename-album-dialog');
    this.nameInput = page.getByTestId('rename-album-name-input');
    this.saveButton = page.getByTestId('rename-album-save-button');
    this.cancelButton = page.getByTestId('rename-album-cancel-button');
    this.errorMessage = page.getByTestId('rename-album-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setName(name: string): Promise<void> {
    await this.nameInput.clear();
    await this.nameInput.fill(name);
  }

  async getName(): Promise<string> {
    return this.nameInput.inputValue();
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  async saveAndWaitForClose(timeout = 30000): Promise<void> {
    await this.saveButton.click();
    await this.waitForClose(timeout);
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async rename(newName: string): Promise<void> {
    await this.setName(newName);
    await this.saveAndWaitForClose();
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectSaveDisabled(): Promise<void> {
    await expect(this.saveButton).toBeDisabled();
  }

  async expectSaveEnabled(): Promise<void> {
    await expect(this.saveButton).toBeEnabled();
  }
}
