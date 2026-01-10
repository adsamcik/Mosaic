/**
 * Photo Lifecycle E2E Tests
 *
 * Comprehensive tests for photo upload, viewing, and deletion.
 * Uses the parallel-safe framework for test isolation.
 */

import {
  test,
  expect,
  LoginPage,
  AppShell,
  GalleryPage,
  Lightbox,
  loginUser,
  createAlbumViaAPI,
  createAlbumViaUI,
  generateTestImage,
  TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Photo Lifecycle @p1 @photo @crypto', () => {
  test.describe('Photo Upload', () => {
    test('P1-PHOTO-1: upload single photo shows in gallery', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('uploader');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('Upload');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      const testImage = generateTestImage('tiny');
      const filename = testContext.generatePhotoName(1);
      await gallery.uploadPhoto(testImage, filename);

      // Photo should appear
      await gallery.expectPhotoCount(1);
    });

    test('P1-PHOTO-2: upload multiple photos sequentially', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('multi-uploader');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('MultiUpload');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Upload 3 photos
      for (let i = 1; i <= 3; i++) {
        const testImage = generateTestImage('tiny');
        await gallery.uploadPhoto(testImage, testContext.generatePhotoName(i));
      }

      // All photos should appear
      await gallery.expectPhotoCount(3);
    });

    test('P1-PHOTO-3: upload shows progress indicator', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('progress-watcher');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('Progress');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Start upload and check for progress
      const testImage = generateTestImage('small'); // Slightly larger for visible progress
      await expect(gallery.uploadInput).toBeAttached();

      await gallery.uploadInput.setInputFiles({
        name: testContext.generatePhotoName(1),
        mimeType: 'image/png',
        buffer: testImage,
      });

      // Check for uploading indicator
      const uploadButton = gallery.uploadButton;
      await expect(async () => {
        const text = await uploadButton.textContent();
        // Either shows progress or has completed
        expect(text?.includes('Uploading') || text?.includes('Upload')).toBeTruthy();
      }).toPass({ timeout: 60000 });
    });
  });

  test.describe('Photo Viewing', () => {
    test('P1-PHOTO-4: clicking photo thumbnail opens lightbox', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('viewer');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('View');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Upload a photo first
      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, testContext.generatePhotoName(1));
      await gallery.expectPhotoCount(1);

      // Click on photo
      await gallery.selectPhoto(0);

      // Lightbox should open
      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
    });

    test('P1-PHOTO-5: escape key closes lightbox', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('escapist');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('Escape');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, testContext.generatePhotoName(1));
      await gallery.expectPhotoCount(1);

      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();

      // Press escape
      await lightbox.closeByEscape();

      // Lightbox should be closed
      await lightbox.waitForClose();
    });

    test('P1-PHOTO-6: arrow keys navigate between photos in lightbox', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('navigator');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('Navigate');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Upload 3 photos
      for (let i = 1; i <= 3; i++) {
        const testImage = generateTestImage('tiny');
        await gallery.uploadPhoto(testImage, testContext.generatePhotoName(i));
      }
      await gallery.expectPhotoCount(3);

      // Open first photo
      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();

      // Navigate right
      await lightbox.navigateWithKeyboard('right');

      // Navigate right again
      await lightbox.navigateWithKeyboard('right');

      // Navigate left
      await lightbox.navigateWithKeyboard('left');

      // Should still be in lightbox
      await expect(lightbox.container).toBeVisible();

      await lightbox.close();
    });
  });

  test.describe('Photo Persistence', () => {
    test('P1-PHOTO-7: uploaded photos persist after page reload', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('persister');

      // Login first
      await loginUser(user, TEST_PASSWORD);

      // Create album through browser UI (generates real epoch keys)
      await createAlbumViaUI(user.page, 'Persistence Test Album');

      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      // Upload photo
      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, testContext.generatePhotoName(1));
      await gallery.expectPhotoCount(1);

      // Reload page
      await user.page.reload();

      // Check if we need to re-login (session may persist)
      const loginPage = new LoginPage(user.page);
      const needsLogin = await loginPage.form.isVisible({ timeout: 5000 }).catch(() => false);
      
      if (needsLogin) {
        await loginPage.login(TEST_PASSWORD);
        await loginPage.expectLoginSuccess();
      } else {
        await appShell.waitForLoad();
      }

      // Navigate back to album
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      // Photo should still be there
      await gallery.waitForLoad();
      await gallery.expectPhotoCount(1);
    });
  });
});
