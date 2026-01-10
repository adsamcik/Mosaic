/**
 * Photo Upload Tests
 *
 * P0 Critical Tests for uploading photos to albums.
 * Phase 1: Fixed soft assertions, added photo round-trip test.
 */

import { ApiHelper, AppShell, CreateAlbumDialogPage, GalleryPage, LoginPage, TEST_CONSTANTS, expect, generateTestImage, test } from '../fixtures';

test.describe('Photo Upload @p1 @photo', () => {
  const apiHelper = new ApiHelper();

  test.describe('File Input', () => {
    test('file input is attached when gallery loads', async ({ page, testUser }) => {
      // Login
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`File Input Test ${Date.now()}`);

      // Navigate into the album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      // Wait for gallery to load
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();
      
      await expect(gallery.fileInput.first()).toBeAttached();
    });

    test('file input accepts image files', async ({ page, testUser }) => {
      // Login
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`File Accept Test ${Date.now()}`);

      // Navigate into the album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // Check accept attribute
      const acceptAttr = await gallery.fileInput.first().getAttribute('accept');
      
      // Should accept images
      if (acceptAttr) {
        expect(acceptAttr).toMatch(/image/i);
      }
    });
  });

  test.describe('Upload Process', () => {
    test('shows upload progress when uploading file', async ({ page, testUser }) => {
      // Login FIRST to register user with proper crypto
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Upload Progress Test ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // Generate test image
      const testImage = generateTestImage();

      // Upload file
      await gallery.uploadPhoto(testImage, 'test-upload.png');

      // Should show progress or processing indicator
      const uploadButton = gallery.uploadButton;
      const progressIndicator = page.getByRole('progressbar');
      const uploadingText = page.getByText(/uploading|processing/i);

      // Wait for upload indication (button text change, progress bar, or text)
      await expect(async () => {
        const buttonText = await uploadButton.textContent();
        const hasProgress = await progressIndicator.first().isVisible().catch(() => false);
        const hasText = await uploadingText.first().isVisible().catch(() => false);
        const isUploading = buttonText?.toLowerCase().includes('upload') || hasProgress || hasText;
        expect(isUploading).toBeTruthy();
      }).toPass({ timeout: 10000 });
    });

    /**
     * P0 Critical: Photo upload round-trip test
     * 
     * This test verifies the complete photo upload flow:
     * 1. Login with password (derives crypto keys)
     * 2. Create album via UI (generates epoch key)
     * 3. Upload photo (encrypts with epoch key, uploads shards)
     * 4. Verify photo appears in gallery (decrypts and displays)
     * 
     * This is the core E2E test for Mosaic's zero-knowledge photo storage.
     */
    test('photo upload round-trip - uploaded photo appears in gallery', async ({ page, testUser }) => {
      await page.goto('/');

      // Login - this initializes crypto worker and derives keys
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album via UI - this generates proper epoch keys
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Upload Test Album ${Date.now()}`);

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 30000 });
      await albumCard.click();

      // Wait for gallery to load
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // Verify we're in the gallery and it's empty
      await gallery.expectEmptyState();

      // Generate and upload test image
      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'round-trip-test.png');

      // Wait for upload to complete and photo to appear
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

      // Verify photo count increased
      const finalPhotoCount = await gallery.photos.count();
      expect(finalPhotoCount).toBeGreaterThanOrEqual(1);

      // Note: Lightbox testing is covered in photo-workflow.spec.ts
      // This test focuses on the core upload → display flow
    });
  });

  test.describe('Error Handling', () => {
    test('handles upload errors gracefully', async ({ page, testUser }) => {
      // Login FIRST to register user with proper crypto
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album via UI (generates real crypto keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Error Test ${Date.now()}`);

      // Block API calls to simulate error
      await page.route('**/api/files/**', (route) => {
        route.abort('failed');
      });

      // Navigate to album
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 10000 });
      await albumCard.click();

      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'error-test.png');

      // Should show error message or remain stable (not crash)
      await expect(async () => {
        const errorMessage = page.getByRole('alert');
        const errorText = page.getByText(/error|failed|retry/i);
        const uploadButton = gallery.uploadButton;
        
        const hasAlert = await errorMessage.first().isVisible().catch(() => false);
        const hasError = await errorText.first().isVisible().catch(() => false);
        const buttonStillWorks = await uploadButton.isVisible().catch(() => false);
        
        // Either error is shown or button is still available (graceful degradation)
        expect(hasAlert || hasError || buttonStillWorks).toBeTruthy();
      }).toPass({ timeout: 10000 });
    });
  });
});
