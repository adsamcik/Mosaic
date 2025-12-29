/**
 * Photo Gallery Tests
 *
 * P1 Tests for viewing and interacting with photos.
 * Phase 1: Fixed soft assertions, added proper waits.
 */

import { ApiHelper, expect, GalleryPage, LoginPage, test, TEST_CONSTANTS } from '../fixtures';

test.describe('Photo Gallery @p1 @gallery', () => {
  const apiHelper = new ApiHelper();

  test.describe('Gallery Display', () => {
    test('displays gallery when navigating to album', async ({ authenticatedPage, testUser }) => {
      // Create album
      const album = await apiHelper.createAlbum(testUser);

      await authenticatedPage.goto('/');

      // Login
      const loginPage = new LoginPage(authenticatedPage);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Navigate to album
      const albumCard = authenticatedPage.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Should show gallery
      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();
    });

    test('shows empty state in gallery without photos', async ({ authenticatedPage, testUser }) => {
      const album = await apiHelper.createAlbum(testUser);

      await authenticatedPage.goto('/');

      // Login
      const loginPage = new LoginPage(authenticatedPage);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Navigate to album
      const albumCard = authenticatedPage.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Should show gallery with empty state
      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();
      await gallery.expectEmptyState();
    });
  });

  test.describe('Upload Button', () => {
    test('shows upload button in gallery', async ({ authenticatedPage, testUser }) => {
      const album = await apiHelper.createAlbum(testUser);

      await authenticatedPage.goto('/');

      // Login
      const loginPage = new LoginPage(authenticatedPage);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Navigate to album
      const albumCard = authenticatedPage.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Check for upload button
      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();
      await gallery.expectUploadButtonVisible();
    });

    test('file input accepts images', async ({ authenticatedPage, testUser }) => {
      const album = await apiHelper.createAlbum(testUser);

      await authenticatedPage.goto('/');

      // Login
      const loginPage = new LoginPage(authenticatedPage);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Navigate to album
      const albumCard = authenticatedPage.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Check file input
      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();
      
      await expect(gallery.fileInput.first()).toBeAttached();

      // Check accept attribute
      const acceptAttr = await gallery.fileInput.first().getAttribute('accept');
      if (acceptAttr) {
        expect(acceptAttr).toMatch(/image/i);
      }
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('supports keyboard navigation', async ({ authenticatedPage, testUser }) => {
      const album = await apiHelper.createAlbum(testUser);

      await authenticatedPage.goto('/');

      // Login
      const loginPage = new LoginPage(authenticatedPage);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Navigate to album
      const albumCard = authenticatedPage.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Wait for gallery
      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();

      // Tab through elements - start from the body to ensure clean focus state
      await authenticatedPage.keyboard.press('Tab');

      // After Tab, some element should have focus
      // Check that an element is focused (may be hidden file input or visible button)
      const activeElement = await authenticatedPage.evaluate(() => {
        return document.activeElement?.tagName || 'BODY';
      });
      
      // Active element should not be BODY after tabbing
      expect(activeElement).not.toBe('BODY');
    });
  });
});
