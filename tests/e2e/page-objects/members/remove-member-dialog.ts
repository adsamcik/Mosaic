/**
 * Remove Member Dialog Page Object
 * Handles the confirmation dialog when removing a member from an album.
 * Note: This dialog also shows key rotation progress.
 */

import { type Page, type Locator, expect } from '../base';

export class RemoveMemberDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;
  readonly progressIndicator: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('remove-member-dialog');
    this.confirmButton = page.getByTestId('confirm-remove-button');
    this.cancelButton = page.getByTestId('cancel-remove-button');
    this.progressIndicator = page.getByTestId('removal-progress');
    this.errorMessage = page.getByTestId('remove-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 30000): Promise<void> {
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

  async expectProgress(): Promise<void> {
    await expect(this.progressIndicator).toBeVisible({ timeout: 5000 });
  }

  async expectError(message?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (message) {
      await expect(this.errorMessage).toHaveText(message);
    }
  }
}
