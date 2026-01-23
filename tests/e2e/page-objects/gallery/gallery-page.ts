/**
 * Gallery Page Object
 */

import { type Page, type Locator, expect } from '../base';

export class GalleryPage {
  readonly page: Page;
  readonly gallery: Locator;
  readonly photoGrid: Locator;
  readonly justifiedGrid: Locator;
  readonly uploadButton: Locator;
  readonly uploadInput: Locator;
  readonly fileInput: Locator; // Alias for uploadInput for backward compatibility
  readonly emptyState: Locator;
  readonly viewJustifiedButton: Locator;
  readonly viewGridButton: Locator;
  readonly viewMapButton: Locator;
  readonly membersButton: Locator;
  readonly shareButton: Locator;
  readonly renameAlbumButton: Locator;
  readonly deleteAlbumButton: Locator;
  readonly albumSettingsButton: Locator;
  readonly albumSettingsMenu: Locator;

  constructor(page: Page) {
    this.page = page;
    this.gallery = page.locator('.gallery, .photo-gallery, [data-testid*="gallery"]');
    this.photoGrid = page.getByTestId('photo-grid');
    this.justifiedGrid = page.getByTestId('justified-grid');
    this.uploadButton = page.getByTestId('upload-button');
    this.uploadInput = page.getByTestId('upload-input');
    this.fileInput = this.uploadInput; // Alias for backward compatibility
    this.emptyState = page.locator('[data-testid="justified-grid-empty"], [data-testid="photo-grid-empty"]');
    this.viewJustifiedButton = page.getByTestId('view-toggle-justified');
    this.viewGridButton = page.getByTestId('view-toggle-grid');
    this.viewMapButton = page.getByTestId('view-toggle-map');
    this.membersButton = page.getByTestId('menu-share-button');
    this.shareButton = page.getByTestId('menu-links-button');
    this.renameAlbumButton = page.getByTestId('menu-rename-button');
    this.deleteAlbumButton = page.getByTestId('menu-delete-button');
    this.albumSettingsButton = page.getByTestId('album-settings-button');
    this.albumSettingsMenu = page.getByTestId('album-settings-menu');
  }

  async waitForLoad(timeout = 30000): Promise<void> {
    await expect(this.gallery).toBeVisible({ timeout });
  }

  /**
   * Get photos locator
   */
  getPhotos(): Locator {
    return this.page.locator(
      '[data-testid="photo-thumbnail"], [data-testid="justified-photo-thumbnail"]'
    );
  }

  /**
   * Get photos locator (getter for backward compatibility)
   */
  get photos(): Locator {
    return this.getPhotos();
  }

  async getPhotoCount(): Promise<number> {
    return this.getPhotos().count();
  }

  async expectPhotoCount(count: number, timeout = 30000): Promise<void> {
    await expect(this.getPhotos()).toHaveCount(count, { timeout });
  }

  async expectEmptyState(): Promise<void> {
    await expect(this.emptyState.first()).toBeVisible({ timeout: 10000 });
  }

  /**
   * Expect upload button to be visible (for backward compatibility)
   */
  async expectUploadButtonVisible(): Promise<void> {
    await expect(this.uploadButton).toBeVisible({ timeout: 10000 });
  }

  /**
   * Low-level method to set file input without waiting for upload completion.
   * Use this for concurrent uploads where you want to trigger uploads simultaneously
   * and wait for results separately.
   */
  async setFileInput(imageBuffer: Buffer, filename = 'test.png'): Promise<void> {
    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });
    await this.uploadInput.setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: imageBuffer,
    });
  }

  async uploadPhoto(imageBuffer: Buffer, filename = 'test.png'): Promise<void> {
    const photoCountBefore = await this.getPhotos().count();
    const startTime = Date.now();
    console.log(`[GalleryPage PO] Photo count before: ${photoCountBefore}`);
    
    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });
    console.log(`[GalleryPage PO] Upload input found at T+${Date.now() - startTime}ms`);

    const expectedCount = photoCountBefore + 1;
    let attempt = 0;
    const maxAttempts = 3;
    
    while (attempt < maxAttempts) {
      attempt++;
      console.log(`[GalleryPage PO] Upload attempt ${attempt}/${maxAttempts} at T+${Date.now() - startTime}ms`);
      
      await this.uploadInput.setInputFiles({
        name: filename,
        mimeType: 'image/png',
        buffer: imageBuffer,
      });
      console.log(`[GalleryPage PO] Files set at T+${Date.now() - startTime}ms`);

      // INTENTIONAL: Brief poll delay in retry loop to detect async upload trigger
      await this.page.waitForTimeout(100);
      
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;
      
      console.log(`[GalleryPage PO] Quick check at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}, uploading=${isUploading}, hasNew=${hasNewPhoto}`);
      
      if (isUploading || hasNewPhoto) {
        console.log(`[GalleryPage PO] Upload triggered on attempt ${attempt}`);
        break;
      }
      
      // INTENTIONAL: Secondary poll delay in retry loop for delayed upload detection
      await this.page.waitForTimeout(500);
      const buttonText2 = await btn.textContent().catch(() => '');
      const currentCount2 = await this.getPhotos().count();
      const isUploading2 = buttonText2?.includes('Uploading') || /\d+%/.test(buttonText2 || '');
      const hasNewPhoto2 = currentCount2 >= expectedCount;
      
      if (isUploading2 || hasNewPhoto2) {
        console.log(`[GalleryPage PO] Upload triggered on attempt ${attempt} (delayed detection)`);
        break;
      }
      
      if (attempt < maxAttempts) {
        console.log(`[GalleryPage PO] Upload not triggered, will retry...`);
        await this.uploadInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
      }
    }

    let pollCount = 0;
    await expect(async () => {
      pollCount++;
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;
      
      if (pollCount <= 5 || pollCount % 10 === 0) {
        console.log(`[GalleryPage PO] Poll #${pollCount} at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}, uploading=${isUploading}, hasNew=${hasNewPhoto}`);
      }
      
      expect(isUploading || hasNewPhoto).toBe(true);
    }).toPass({ timeout: 30000, intervals: [100, 200, 500, 1000] });
    console.log(`[GalleryPage PO] Upload started or photo appeared at T+${Date.now() - startTime}ms (${pollCount} polls)`);

    let completePollCount = 0;
    await expect(async () => {
      completePollCount++;
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      
      if (completePollCount <= 3 || completePollCount % 5 === 0) {
        console.log(`[GalleryPage PO] Complete poll #${completePollCount} at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}`);
      }
      
      expect(!isUploading && currentCount >= expectedCount).toBe(true);
    }).toPass({ timeout: 60000, intervals: [100, 250, 500, 1000] });
    
    console.log(`[GalleryPage PO] Upload complete at T+${Date.now() - startTime}ms. Final count: ${await this.getPhotos().count()}`);
  }

  async uploadPhotoWithMime(imageBuffer: Buffer, filename: string, mimeType: string): Promise<void> {
    const photoCountBefore = await this.getPhotos().count();
    const startTime = Date.now();
    console.log(`[GalleryPage PO] uploadPhotoWithMime: ${filename} (${mimeType}), photo count before: ${photoCountBefore}`);

    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });
    const expectedCount = photoCountBefore + 1;

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`[GalleryPage PO] Upload attempt ${attempt}/${maxAttempts} at T+${Date.now() - startTime}ms`);

      await this.uploadInput.setInputFiles({
        name: filename,
        mimeType: mimeType,
        buffer: imageBuffer,
      });

      // INTENTIONAL: Brief poll delay in retry loop to detect async upload trigger
      await this.page.waitForTimeout(100);

      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;

      if (isUploading || hasNewPhoto) {
        console.log(`[GalleryPage PO] Upload triggered on attempt ${attempt}`);
        break;
      }

      // INTENTIONAL: Secondary poll delay in retry loop for delayed upload detection
      await this.page.waitForTimeout(500);
      const buttonText2 = await btn.textContent().catch(() => '');
      const currentCount2 = await this.getPhotos().count();
      const isUploading2 = buttonText2?.includes('Uploading') || /\d+%/.test(buttonText2 || '');
      const hasNewPhoto2 = currentCount2 >= expectedCount;

      if (isUploading2 || hasNewPhoto2) {
        console.log(`[GalleryPage PO] Upload triggered on attempt ${attempt} (delayed detection)`);
        break;
      }

      if (attempt < maxAttempts) {
        console.log(`[GalleryPage PO] Upload not triggered, will retry...`);
        await this.uploadInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
      }
    }

    await expect(async () => {
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');

      expect(!isUploading && currentCount >= expectedCount).toBe(true);
    }).toPass({ timeout: 90000, intervals: [100, 250, 500, 1000] });

    console.log(`[GalleryPage PO] Upload complete at T+${Date.now() - startTime}ms. Final count: ${await this.getPhotos().count()}`);
  }

  async uploadMultiplePhotos(images: Array<{ buffer: Buffer; filename: string }>): Promise<void> {
    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });
    await this.uploadInput.setInputFiles(
      images.map((img) => ({
        name: img.filename,
        mimeType: 'image/png',
        buffer: img.buffer,
      }))
    );
  }

  async waitForSync(timeout = 60000): Promise<void> {
    const startTime = Date.now();
    const pendingGridPhotos = this.page.getByTestId('pending-photo-thumbnail');
    const pendingOverlays = this.page.getByTestId('photo-pending-overlay');
    
    const initialGridCount = await pendingGridPhotos.count();
    const initialOverlayCount = await pendingOverlays.count();
    const minExpectedPhotos = initialOverlayCount > 0 ? initialOverlayCount : 0;
    
    console.log(`[GalleryPage PO] waitForSync started: ${initialGridCount} pending grid photos, ${initialOverlayCount} pending overlays, expecting at least ${minExpectedPhotos} photos after sync`);
    
    if (initialGridCount + initialOverlayCount === 0) {
      console.log(`[GalleryPage PO] waitForSync complete after ${Date.now() - startTime}ms (no pending photos)`);
      return;
    }
    
    await expect(async () => {
      const gridCount = await pendingGridPhotos.count();
      const overlayCount = await pendingOverlays.count();
      const stablePhotoCount = await this.getPhotos().count();
      
      expect(gridCount + overlayCount).toBe(0);
      
      if (minExpectedPhotos > 0) {
        expect(stablePhotoCount).toBeGreaterThanOrEqual(minExpectedPhotos);
      }
    }).toPass({ timeout, intervals: [100, 250, 500, 1000] });
    
    console.log(`[GalleryPage PO] waitForSync complete after ${Date.now() - startTime}ms`);
  }

  async selectPhoto(index: number): Promise<void> {
    await this.waitForSync();
    
    let clicked = false;
    await expect(async () => {
      const photos = await this.getPhotos().all();
      console.log(`[GalleryPage PO] selectPhoto(${index}): found ${photos.length} photos`);
      if (!photos[index]) {
        throw new Error(`Photo at index ${index} not found, have ${photos.length} photos`);
      }
      if (!clicked) {
        await photos[index].click();
        clicked = true;
        console.log(`[GalleryPage PO] selectPhoto(${index}): clicked`);
      }
    }).toPass({ timeout: 30000, intervals: [100, 250, 500] });
  }

  async openMembers(): Promise<void> {
    const membersPanel = this.page.getByTestId('member-panel');
    const isPanelOpen = await membersPanel.isVisible().catch(() => false);
    if (isPanelOpen) {
      const closeBtn = this.page.getByTestId('close-members-button');
      await closeBtn.click();
      await expect(membersPanel).toBeHidden({ timeout: 5000 });
    }
    
    await expect(async () => {
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      if (!isMenuVisible) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      await expect(this.membersButton).toBeVisible({ timeout: 2000 });
      await this.membersButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async setViewMode(mode: 'justified' | 'grid' | 'map'): Promise<void> {
    switch (mode) {
      case 'justified':
        await this.viewJustifiedButton.click();
        break;
      case 'grid':
        await this.viewGridButton.click();
        break;
      case 'map':
        await this.viewMapButton.click();
        break;
    }
  }

  async openShareLinks(): Promise<void> {
    await expect(async () => {
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      if (!isMenuVisible) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      await expect(this.shareButton).toBeVisible({ timeout: 2000 });
      await this.shareButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async openAlbumSettings(): Promise<void> {
    await expect(async () => {
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      if (!isMenuVisible) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async openRenameDialog(): Promise<void> {
    await expect(async () => {
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      const isRenameButtonVisible = isMenuVisible && await this.renameAlbumButton.isVisible().catch(() => false);
      
      if (isMenuVisible && !isRenameButtonVisible) {
        await this.page.keyboard.press('Escape');
        await expect(this.albumSettingsMenu).toBeHidden({ timeout: 1000 }).catch(() => {});
      }
      
      if (!await this.albumSettingsMenu.isVisible().catch(() => false)) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      
      await expect(this.renameAlbumButton).toBeVisible({ timeout: 2000 });
      await this.renameAlbumButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async clickDeleteAlbum(): Promise<void> {
    await expect(async () => {
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      const isDeleteButtonVisible = isMenuVisible && await this.deleteAlbumButton.isVisible().catch(() => false);
      
      if (isMenuVisible && !isDeleteButtonVisible) {
        await this.page.keyboard.press('Escape');
        await expect(this.albumSettingsMenu).toBeHidden({ timeout: 1000 }).catch(() => {});
      }
      
      if (!await this.albumSettingsMenu.isVisible().catch(() => false)) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      
      await expect(this.deleteAlbumButton).toBeVisible({ timeout: 2000 });
      await this.deleteAlbumButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async expectDeleteButtonVisible(): Promise<void> {
    await this.openAlbumSettings();
    await expect(this.deleteAlbumButton).toBeVisible({ timeout: 5000 });
  }

  async expectDeleteButtonHidden(): Promise<void> {
    const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
    if (!isMenuVisible) {
      await this.albumSettingsButton.click().catch(() => {});
    }
    await expect(this.deleteAlbumButton).toBeHidden({ timeout: 5000 });
  }
}
