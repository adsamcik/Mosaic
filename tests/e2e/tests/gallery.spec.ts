/**
 * Photo Gallery Tests
 *
 * Tests for viewing and interacting with photos.
 */

import { test, expect, GalleryPage, ApiHelper } from '../fixtures';

test.describe('Photo Gallery', () => {
  const apiHelper = new ApiHelper();

  test('displays photo grid in album', async ({ authenticatedPage, testUser }) => {
    // Create album
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto(`/albums/${album.id}`);

    const gallery = new GalleryPage(authenticatedPage);

    // Should show gallery (may be empty)
    await expect(async () => {
      const galleryElement = authenticatedPage.getByTestId('gallery');
      const emptyState = authenticatedPage.getByText(/no photos|upload|empty/i);
      
      const hasGallery = await galleryElement.isVisible().catch(() => false);
      const hasEmpty = await emptyState.first().isVisible().catch(() => false);
      
      expect(hasGallery || hasEmpty).toBeTruthy();
    }).toPass({ timeout: 30000 });
  });

  test('shows upload button in gallery', async ({ authenticatedPage, testUser }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto(`/albums/${album.id}`);

    await expect(async () => {
      const uploadButton = authenticatedPage.getByTestId('upload-button');
      const uploadInput = authenticatedPage.locator('input[type="file"]');
      
      const hasButton = await uploadButton.isVisible().catch(() => false);
      const hasInput = await uploadInput.first().isVisible().catch(() => false);
      
      // Upload should be accessible somehow
      expect(hasButton || hasInput).toBeTruthy();
    }).toPass({ timeout: 30000 });
  });

  test('supports keyboard navigation', async ({ authenticatedPage, testUser }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto(`/albums/${album.id}`);

    // Tab through elements
    await authenticatedPage.keyboard.press('Tab');
    await authenticatedPage.keyboard.press('Tab');

    // Should have focus indicator
    const focusedElement = await authenticatedPage.locator(':focus').first();
    await expect(focusedElement).toBeVisible();
  });
});
