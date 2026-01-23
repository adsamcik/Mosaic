/**
 * Members Panel Page Object
 */

import { type Page, type Locator, expect } from '../base';
import { RemoveMemberDialog } from './remove-member-dialog';

export class MembersPanel {
  readonly page: Page;
  readonly panel: Locator;
  readonly memberList: Locator;
  readonly inviteButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId('member-panel');
    this.memberList = page.getByTestId('member-list');
    this.inviteButton = page.getByRole('button', { name: /invite|add member/i });
    this.closeButton = page.getByTestId('close-members-button');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeHidden({ timeout });
  }

  async close(): Promise<void> {
    const isVisible = await this.panel.isVisible().catch(() => false);
    if (isVisible) {
      await this.closeButton.click();
      await this.waitForClose();
    }
  }

  async getMemberRows(): Promise<Locator[]> {
    return this.page.getByTestId('member-item').all();
  }

  async getMemberCount(): Promise<number> {
    return (await this.getMemberRows()).length;
  }

  async openInviteDialog(): Promise<void> {
    await this.inviteButton.click();
  }

  async removeMember(userIdOrDisplayName: string): Promise<void> {
    let memberRow = this.page.getByTestId('member-item').filter({ hasText: userIdOrDisplayName });
    let isVisible = await memberRow.first().isVisible().catch(() => false);
    
    if (!isVisible && userIdOrDisplayName.length > 8) {
      const shortId = userIdOrDisplayName.substring(0, 8);
      memberRow = this.page.getByTestId('member-item').filter({ hasText: shortId });
      isVisible = await memberRow.first().isVisible().catch(() => false);
    }
    
    if (!isVisible) {
      const removeButtons = this.page.getByTestId('member-item').getByRole('button', { name: /remove|delete/i });
      const count = await removeButtons.count();
      if (count > 0) {
        await removeButtons.first().click();
        return;
      }
      throw new Error(`Member not found: ${userIdOrDisplayName}`);
    }
    
    const removeBtn = memberRow.first().getByRole('button', { name: /remove|delete/i });
    await removeBtn.click();
  }

  async expectMemberVisible(userId: string): Promise<void> {
    await expect(
      this.page.getByTestId('member-item').filter({ hasText: userId })
    ).toBeVisible({ timeout: 5000 });
  }

  async expectMemberNotVisible(userId: string): Promise<void> {
    await expect(
      this.page.getByTestId('member-item').filter({ hasText: userId })
    ).toBeHidden({ timeout: 5000 });
  }

  async removeMemberWithConfirmation(userIdOrDisplayName: string): Promise<void> {
    await this.removeMember(userIdOrDisplayName);
    const removeDialog = new RemoveMemberDialog(this.page);
    await removeDialog.waitForOpen();
    await removeDialog.confirm();
  }
}
