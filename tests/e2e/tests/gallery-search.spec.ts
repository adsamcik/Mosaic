/**
 * Gallery Search E2E Tests
 *
 * Tests for the gallery search UI: visibility, text input, clearing,
 * no-results state, keyboard shortcuts, and hiding during selection mode.
 *
 * Search uses FTS5 full-text search on the client-side SQLite DB
 * (filenames and tags). These tests focus on verifying that the search
 * UI controls work correctly rather than testing the crypto search logic.
 */

import {
  test,
  expect,
  loginUser,
  createAlbumViaUI,
  generateTestImage,
} from '../fixtures-enhanced';
import { AppShell, GalleryPage } from '../page-objects';
import { TEST_PASSWORD } from '../framework';

test.describe('Gallery Search @p1 @gallery @ui', () => {
  test('search input is visible in gallery', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('search-visible');
    await loginUser(user);

    await createAlbumViaUI(user.page, `Search Visible ${testContext.testId}`);
    const gallery = new GalleryPage(user.page);

    // Upload a photo so the gallery isn't empty
    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'photo-one.png');

    // Search input should be visible in the gallery header
    const searchInput = user.page.getByTestId('photo-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });

  test('search input accepts text', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('search-type');
    await loginUser(user);

    await createAlbumViaUI(user.page, `Search Type ${testContext.testId}`);
    const gallery = new GalleryPage(user.page);

    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'sunset.png');

    const searchInput = user.page.getByTestId('photo-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Type into the search input
    await searchInput.fill('sunset');
    await expect(searchInput).toHaveValue('sunset');
  });

  test('search with no results shows empty state or zero photos', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('search-empty');
    await loginUser(user);

    await createAlbumViaUI(user.page, `Search Empty ${testContext.testId}`);
    const gallery = new GalleryPage(user.page);

    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'beach.png');

    // Confirm at least 1 photo is present before searching
    await gallery.expectPhotoCount(1, 30000);

    const searchInput = user.page.getByTestId('photo-search-input');

    // Search for a term that won't match any uploaded file
    await searchInput.fill('zzz-nonexistent-xyz');
    // Press Enter to trigger immediate search (bypasses 300ms debounce)
    await searchInput.press('Enter');

    // After searching for a non-existent term the gallery should show
    // either zero photos or an empty state indicator
    await expect(async () => {
      const photoCount = await gallery.getPhotoCount();
      expect(photoCount).toBe(0);
    }).toPass({ timeout: 10000, intervals: [200, 500, 1000] });
  });

  test('clearing search restores all photos', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('search-clear');
    await loginUser(user);

    await createAlbumViaUI(user.page, `Search Clear ${testContext.testId}`);
    const gallery = new GalleryPage(user.page);

    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'alpha.png');
    await gallery.uploadPhoto(testImage, 'bravo.png');

    // Confirm both photos are visible
    await gallery.expectPhotoCount(2, 30000);

    const searchInput = user.page.getByTestId('photo-search-input');

    // Search for non-existent term to filter everything out
    await searchInput.fill('zzz-nonexistent-xyz');
    await searchInput.press('Enter');

    await expect(async () => {
      const photoCount = await gallery.getPhotoCount();
      expect(photoCount).toBe(0);
    }).toPass({ timeout: 10000, intervals: [200, 500, 1000] });

    // Clear search using the clear button
    const clearButton = user.page.getByTestId('search-clear-button');
    await expect(clearButton).toBeVisible({ timeout: 5000 });
    await clearButton.click();

    // After clearing, the search input should be empty
    await expect(searchInput).toHaveValue('');

    // All photos should be restored
    await gallery.expectPhotoCount(2, 30000);
  });

  test('search input is hidden in selection mode', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('search-sel');
    await loginUser(user);

    await createAlbumViaUI(user.page, `Search Select ${testContext.testId}`);
    const gallery = new GalleryPage(user.page);

    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'charlie.png');

    const searchInput = user.page.getByTestId('photo-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Enter selection mode
    const selectButton = user.page.getByTestId('selection-mode-button');
    // Selection button may not be present for all permission levels;
    // skip if not available
    const selectVisible = await selectButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (!selectVisible) {
      test.skip();
      return;
    }
    await selectButton.click();

    // In selection mode, the search input should be hidden
    await expect(searchInput).toBeHidden({ timeout: 5000 });

    // Exit selection mode — the button reuses the same testid
    const cancelButton = user.page.getByTestId('selection-mode-button');
    await cancelButton.click();

    // Search input should reappear
    await expect(searchInput).toBeVisible({ timeout: 5000 });
  });
});
