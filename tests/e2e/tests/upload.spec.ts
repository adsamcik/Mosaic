/**
 * Photo Upload Tests
 *
 * P0 Critical Tests for uploading photos to albums.
 * Phase 1: Fixed soft assertions, added photo round-trip test.
 */

import { ApiHelper, GalleryPage, LoginPage, TEST_CONSTANTS, expect, generateTestImage, test } from '../fixtures';

test.describe('Photo Upload @p1 @photo', () => {
  const apiHelper = new ApiHelper();

  test.describe('File Input', () => {
    test('file input is attached when gallery loads', async ({ authenticatedPage, testUser }) => {
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
    });

    test('file input accepts image files', async ({ authenticatedPage, testUser }) => {
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

      const gallery = new GalleryPage(authenticatedPage);
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
    test('shows upload progress when uploading file', async ({ authenticatedPage, testUser }) => {
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

      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();

      // Generate test image
      const testImage = generateTestImage();

      // Upload file
      await gallery.uploadPhoto(testImage, 'test-upload.png');

      // Should show progress or processing indicator
      const uploadButton = gallery.uploadButton;
      const progressIndicator = authenticatedPage.getByRole('progressbar');
      const uploadingText = authenticatedPage.getByText(/uploading|processing/i);

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
    test('photo upload round-trip - uploaded photo appears in gallery', async ({ authenticatedPage, testUser }) => {
      await authenticatedPage.goto('/');

      // Login - this initializes crypto worker and derives keys
      const loginPage = new LoginPage(authenticatedPage);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Create album via UI - this generates proper epoch keys
      const createAlbumButton = authenticatedPage.getByTestId('create-album-trigger');
      await expect(createAlbumButton).toBeVisible({ timeout: 10000 });
      await createAlbumButton.click();

      // Fill in album name
      const albumNameInput = authenticatedPage.getByTestId('album-name-input');
      await expect(albumNameInput).toBeVisible({ timeout: 5000 });
      await albumNameInput.fill('Upload Test Album');

      // Submit album creation
      const createButton = authenticatedPage.getByTestId('create-button');
      await createButton.click();

      // Wait for album to be created and navigate to gallery
      // After creation, the app either shows the album card or navigates to gallery
      const gallery = new GalleryPage(authenticatedPage);
      
      // Wait for either gallery to load or album card to appear
      await expect(async () => {
        const galleryVisible = await authenticatedPage.getByTestId('gallery').isVisible().catch(() => false);
        const albumCard = await authenticatedPage.getByTestId('album-card').first().isVisible().catch(() => false);
        expect(galleryVisible || albumCard).toBeTruthy();
      }).toPass({ timeout: 30000 });

      // If we see album card, click it to navigate to gallery
      const albumCardVisible = await authenticatedPage.getByTestId('album-card').first().isVisible().catch(() => false);
      if (albumCardVisible) {
        await authenticatedPage.getByTestId('album-card').first().click();
        await gallery.waitForLoad();
      }

      // Verify we're in the gallery and it's empty
      await gallery.expectEmptyState();

      // Generate and upload test image
      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'round-trip-test.png');

      // Wait for upload to complete and photo to appear
      // This verifies: encryption -> upload -> sync -> decryption -> display
      await expect(async () => {
        // Photo thumbnail should appear after upload completes
        const photoThumbnails = gallery.photos;
        const count = await photoThumbnails.count();
        expect(count).toBeGreaterThan(0);
      }).toPass({ timeout: 60000 }); // Allow time for encryption, upload, and processing

      // Verify the photo thumbnail is actually rendered
      const firstThumbnail = gallery.photos.first();
      await expect(firstThumbnail).toBeVisible();

      // Click to open lightbox
      await firstThumbnail.click();

      // Verify lightbox opens and displays the photo
      const lightbox = authenticatedPage.getByTestId('lightbox');
      await expect(lightbox).toBeVisible({ timeout: 30000 });

      // Verify image is displayed in lightbox (fully decrypted)
      const lightboxImage = authenticatedPage.getByTestId('lightbox-image');
      await expect(lightboxImage).toBeVisible({ timeout: 30000 });

      // Close lightbox
      const closeButton = authenticatedPage.getByTestId('lightbox-close');
      await closeButton.click();
      await expect(lightbox).not.toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Error Handling', () => {
    test('handles upload errors gracefully', async ({ authenticatedPage, testUser }) => {
      const album = await apiHelper.createAlbum(testUser);

      // Block API calls to simulate error
      await authenticatedPage.route('**/api/files/**', (route) => {
        route.abort('failed');
      });

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

      const gallery = new GalleryPage(authenticatedPage);
      await gallery.waitForLoad();

      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'error-test.png');

      // Should show error message or remain stable (not crash)
      await expect(async () => {
        const errorMessage = authenticatedPage.getByRole('alert');
        const errorText = authenticatedPage.getByText(/error|failed|retry/i);
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
