/**
 * Delete Confirmation Dialog Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class DeleteConfirmDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;
  readonly message: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('delete-confirm-dialog');
    this.confirmButton = page.getByRole('button', { name: /delete|confirm|yes/i });
    this.cancelButton = page.getByRole('button', { name: /cancel|no/i });
    this.message = page.getByTestId('delete-confirm-message');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async confirm(): Promise<void> {
    await this.confirmButton.click();
    await this.waitForClose();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }
}
