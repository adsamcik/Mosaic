/**
 * Photo Gallery Tests
 *
 * P1 Tests for viewing and interacting with photos.
 * Phase 1: Fixed soft assertions, added proper waits.
 */

import { AppShell, CreateAlbumDialogPage, expect, GalleryPage, LoginPage, test, TEST_CONSTANTS } from '../fixtures';

test.describe('Photo Gallery @p1 @gallery', () => {

  test.describe('Gallery Display', () => {
    test('displays gallery when navigating to album', async ({ page, testUser }) => {
      // 1. Login FIRST (registers user with crypto)
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // 2. Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Gallery Test ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Should show gallery
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();
    });

    test('shows empty state in gallery without photos', async ({ page, testUser }) => {
      // 1. Login FIRST (registers user with crypto)
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // 2. Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Empty State Test ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Should show gallery with empty state
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();
      await gallery.expectEmptyState();
    });
  });

  test.describe('Upload Button', () => {
    test('shows upload button in gallery', async ({ page, testUser }) => {
      // 1. Login FIRST (registers user with crypto)
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // 2. Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Upload Button Test ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Check for upload button
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();
      await gallery.expectUploadButtonVisible();
    });

    test('file input accepts images', async ({ page, testUser }) => {
      // 1. Login FIRST (registers user with crypto)
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // 2. Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`File Input Test ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Check file input
      const gallery = new GalleryPage(page);
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
    test('supports keyboard navigation', async ({ page, testUser }) => {
      // 1. Login FIRST (registers user with crypto)
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // 2. Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Keyboard Nav Test ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Wait for gallery
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // Tab through elements - start from the body to ensure clean focus state
      await page.keyboard.press('Tab');

      // After Tab, some element should have focus
      // Check that an element is focused (may be hidden file input or visible button)
      const activeElement = await page.evaluate(() => {
        return document.activeElement?.tagName || 'BODY';
      });
      
      // Active element should not be BODY after tabbing
      expect(activeElement).not.toBe('BODY');
    });
  });
});
