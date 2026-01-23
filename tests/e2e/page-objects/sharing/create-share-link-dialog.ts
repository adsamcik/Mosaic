/**
 * Create Share Link Dialog Page Object
 */
import { expect, type Locator, type Page } from '@playwright/test';

export class CreateShareLinkDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly tierSelector: Locator;
  readonly expiryPresets: Locator;
  readonly maxUsesCheckbox: Locator;
  readonly maxUsesInput: Locator;
  readonly generateButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;
  readonly urlInput: Locator;
  readonly copyButton: Locator;
  readonly doneButton: Locator;
  readonly neverExpiresWarning: Locator;

  constructor(page: Page) {
    this.page = page;
    // Use 'create-share-link-view' which is the actual test ID in the component
    // This view appears when creating a share link within ShareLinksPanel
    this.dialog = page.getByTestId('create-share-link-view');
    this.tierSelector = page.getByTestId('tier-selector');
    this.expiryPresets = page.getByTestId('expiry-presets');
    this.maxUsesCheckbox = page.getByTestId('max-uses-checkbox');
    this.maxUsesInput = page.getByTestId('max-uses-input');
    this.generateButton = page.getByTestId('generate-button');
    this.cancelButton = page.getByTestId('cancel-button');
    this.errorMessage = page.getByTestId('share-link-error');
    this.urlInput = page.getByTestId('share-url-input');
    this.copyButton = page.getByTestId('copy-link-button');
    this.doneButton = page.getByTestId('done-button');
    this.neverExpiresWarning = page.getByTestId('never-expires-warning');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async selectTier(tier: 'view' | 'download'): Promise<void> {
    const tierButton = this.tierSelector.locator(`[data-tier="${tier}"], button:has-text("${tier}")`);
    await tierButton.first().click();
  }

  async selectExpiry(preset: string): Promise<void> {
    const presetButton = this.page.getByTestId(`expiry-preset-${preset.toLowerCase().replace(/\s/g, '-')}`);
    await presetButton.click();
  }

  async setMaxUses(uses: number): Promise<void> {
    await this.maxUsesCheckbox.check();
    await this.maxUsesInput.fill(uses.toString());
  }

  async generate(): Promise<void> {
    await this.generateButton.click();
    // Wait for the success state with URL input
    await expect(this.urlInput).toBeVisible({ timeout: 30000 });
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async done(): Promise<void> {
    await this.doneButton.click();
    await this.waitForClose();
    // Wait for the share link list to refresh - the list is refetched asynchronously after dialog closes
    // We need at least one share-link-item to appear before returning
    await expect(this.page.getByTestId('share-link-item').first()).toBeVisible({ timeout: 10000 });
  }

  async copyLink(): Promise<string> {
    const url = await this.urlInput.inputValue();
    await this.copyButton.click();
    return url;
  }

  async getGeneratedUrl(): Promise<string> {
    return this.urlInput.inputValue();
  }
}
