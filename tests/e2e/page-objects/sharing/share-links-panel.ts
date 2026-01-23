/**
 * Share Links Panel Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class ShareLinksPanel {
  readonly page: Page;
  readonly panel: Locator;
  readonly closeButton: Locator;
  readonly createButton: Locator;
  readonly linksList: Locator;
  readonly emptyState: Locator;
  readonly errorState: Locator;
  readonly loadingState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId('share-links-panel');
    this.closeButton = page.getByTestId('close-share-links-button');
    this.createButton = page.getByTestId('create-share-link-button');
    this.linksList = page.getByTestId('active-share-links');
    this.emptyState = page.getByTestId('share-links-empty');
    this.errorState = page.getByTestId('share-links-error');
    this.loadingState = page.getByTestId('share-links-loading');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeHidden({ timeout });
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await this.waitForClose();
  }

  async openCreateDialog(): Promise<void> {
    await this.createButton.click();
  }

  async getLinkItems(): Promise<Locator[]> {
    return this.page.getByTestId('share-link-item').all();
  }

  async getLinkCount(): Promise<number> {
    return (await this.getLinkItems()).length;
  }

  async copyLink(index: number): Promise<void> {
    const links = await this.getLinkItems();
    if (links[index]) {
      await links[index].getByTestId('copy-link-button').click();
    }
  }

  async revokeLink(index: number): Promise<void> {
    const links = await this.getLinkItems();
    if (links[index]) {
      await links[index].getByTestId('revoke-link-button').click();
      // Wait for and click the confirmation button in the revoke dialog
      await this.page.getByTestId('confirm-revoke-button').click();
      // Wait for the link to be removed from the list
      await this.page.waitForTimeout(500);
    }
  }

  async editLink(index: number): Promise<void> {
    const links = await this.getLinkItems();
    if (links[index]) {
      await links[index].getByTestId('edit-link-button').click();
    }
  }
}
