/**
 * Lightbox Page Object
 */

import { type Page, type Locator, expect } from '../base';

export class Lightbox {
  readonly page: Page;
  readonly container: Locator;
  readonly image: Locator;
  readonly closeButton: Locator;
  readonly nextButton: Locator;
  readonly prevButton: Locator;
  readonly deleteButton: Locator;
  readonly downloadButton: Locator;
  readonly photoInfo: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('lightbox');
    this.image = page.getByTestId('lightbox-image');
    this.closeButton = page.getByTestId('lightbox-close');
    this.nextButton = page.getByTestId('lightbox-next');
    this.prevButton = page.getByTestId('lightbox-prev');
    this.deleteButton = page.getByTestId('lightbox-delete');
    this.downloadButton = page.getByTestId('lightbox-download');
    this.photoInfo = page.getByTestId('lightbox-info');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.container).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.container).toBeHidden({ timeout });
  }

  async waitForImage(timeout = 30000, expectedPhotoId?: string): Promise<void> {
    await expect(this.image).toBeVisible({ timeout });
    await this.page.waitForFunction(
      (photoId) => {
        const img = document.querySelector('[data-testid="lightbox-image"]') as HTMLImageElement;
        return (
          img &&
          img.complete &&
          img.naturalWidth > 0 &&
          (!photoId || img.dataset.photoId === photoId)
        );
      },
      expectedPhotoId ?? null,
      { timeout }
    );
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await this.waitForClose();
  }

  async closeByEscape(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.waitForClose();
  }

  async closeByClickOutside(): Promise<void> {
    await this.container.click({ position: { x: 10, y: 10 } });
    await this.waitForClose();
  }

  async goToNext(timeout = 30000): Promise<void> {
    const previousPhotoId = await this.image.getAttribute('data-photo-id').catch(() => null);
    const previousSrc = await this.image.getAttribute('src').catch(() => null);

    await this.nextButton.click();

    await this.page.waitForFunction(
      ({ photoId, src }) => {
        const img = document.querySelector('[data-testid="lightbox-image"]') as HTMLImageElement | null;
        if (!img || !img.complete || img.naturalWidth <= 0) {
          return false;
        }

        const photoChanged = photoId ? img.dataset.photoId !== photoId : true;
        const srcChanged = src ? img.getAttribute('src') !== src : true;
        return photoChanged && srcChanged;
      },
      { photoId: previousPhotoId, src: previousSrc },
      { timeout }
    );
  }

  async goToPrevious(timeout = 30000): Promise<void> {
    const previousPhotoId = await this.image.getAttribute('data-photo-id').catch(() => null);
    const previousSrc = await this.image.getAttribute('src').catch(() => null);

    await this.prevButton.click();

    await this.page.waitForFunction(
      ({ photoId, src }) => {
        const img = document.querySelector('[data-testid="lightbox-image"]') as HTMLImageElement | null;
        if (!img || !img.complete || img.naturalWidth <= 0) {
          return false;
        }

        const photoChanged = photoId ? img.dataset.photoId !== photoId : true;
        const srcChanged = src ? img.getAttribute('src') !== src : true;
        return photoChanged && srcChanged;
      },
      { photoId: previousPhotoId, src: previousSrc },
      { timeout }
    );
  }

  async navigateWithKeyboard(direction: 'left' | 'right'): Promise<void> {
    await this.page.keyboard.press(direction === 'right' ? 'ArrowRight' : 'ArrowLeft');
  }

  async deletePhoto(): Promise<void> {
    await this.deleteButton.click();
  }

  async download(): Promise<void> {
    await this.downloadButton.click();
  }
}
