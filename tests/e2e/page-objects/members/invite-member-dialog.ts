/**
 * Invite Member Dialog Page Object
 */

import { type Page, type Locator, expect } from '../base';

export class InviteMemberDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly userIdInput: Locator;
  readonly lookupButton: Locator;
  readonly foundUser: Locator;
  readonly roleSelect: Locator;
  readonly inviteButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('invite-member-dialog');
    this.userIdInput = page.getByTestId('user-query-input');
    this.lookupButton = page.getByTestId('lookup-button');
    this.foundUser = page.getByTestId('found-user');
    this.roleSelect = page.getByTestId('role-selector');
    this.inviteButton = page.getByTestId('submit-invite-button');
    this.cancelButton = page.getByTestId('cancel-invite-button');
    this.errorMessage = page.getByTestId('invite-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setUserId(userId: string): Promise<void> {
    await this.userIdInput.fill(userId);
    await this.lookupButton.click();
    await expect(this.foundUser).toBeVisible({ timeout: 30000 });
  }

  async setRole(role: 'viewer' | 'editor'): Promise<void> {
    const roleInput = this.roleSelect.getByRole('radio', { name: new RegExp(role, 'i') });
    if (await roleInput.isVisible().catch(() => false)) {
      await roleInput.check();
    }
  }

  async submit(): Promise<void> {
    await this.inviteButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  async inviteMember(userId: string, role: 'viewer' | 'editor' = 'viewer'): Promise<void> {
    await this.waitForOpen();
    await this.setUserId(userId);
    await this.setRole(role);
    await this.submit();

    // Extended 60s timeout for CI Docker where crypto key generation is slow
    try {
      await this.waitForClose(60000);
    } catch (closeError) {
      // Before re-throwing timeout, check if an error message is displayed
      const hasError = await this.errorMessage.isVisible().catch(() => false);
      if (hasError) {
        const errorText = await this.errorMessage.textContent();
        throw new Error(`Invite failed with error: ${errorText}`);
      }
      // No error visible — genuine timeout
      throw closeError;
    }
  }
}
