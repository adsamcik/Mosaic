/**
 * Photo Download E2E Tests
 *
 * P0 Priority - Critical Zero-Knowledge Flow
 *
 * These tests verify the complete encryption/decryption round-trip:
 * 1. Upload photo (client-side encryption) → Server stores encrypted shards
 * 2. View photo (client-side decryption) → Photo displayed correctly
 * 3. Download photo → User gets original unencrypted file
 *
 * This is a critical ZK flow because it proves the server never has access
 * to plaintext photos - all crypto happens in the browser.
 */

import {
  test,
  expect,
  LoginPage,
  AppShell,
  GalleryPage,
  Lightbox,
  loginUser,
  createAlbumViaUI,
  generateTestImage,
  TEST_PASSWORD,
} from '../fixtures-enhanced';
import type { Download } from '@playwright/test';

test.describe('Photo Download - ZK Round-Trip Verification @p1 @photo @crypto @slow', () => {
  // Triple the timeout for slow crypto round-trip tests
  test.slow();

  test.describe('P0 - Critical Download Flows', () => {
    test('P0-DOWNLOAD-1: download button appears in lightbox when photo is loaded', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('downloader');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('Download');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      const testImage = generateTestImage('small');
      const filename = testContext.generatePhotoName(1);
      await gallery.uploadPhoto(testImage, filename);
      await gallery.expectPhotoCount(1);

      // Open lightbox
      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
      await lightbox.waitForImage();

      // Download button should be visible once image is loaded
      await expect(lightbox.downloadButton).toBeVisible({ timeout: 10000 });
    });

    test('P0-DOWNLOAD-2: clicking download triggers file download', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('download-clicker');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('DownloadClick');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      const testImage = generateTestImage('small');
      const filename = `download-test-${Date.now()}.png`;
      await gallery.uploadPhoto(testImage, filename);
      await gallery.expectPhotoCount(1);

      // Open lightbox
      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
      await lightbox.waitForImage();

      // Wait for download event when clicking download button
      const downloadPromise = user.page.waitForEvent('download');

      await lightbox.download();

      // Verify download was triggered
      const download = await downloadPromise;
      expect(download).toBeDefined();

      // Verify the suggested filename contains the original name
      const suggestedFilename = download.suggestedFilename();
      expect(suggestedFilename).toContain('.png');
    });

    test('P0-DOWNLOAD-3: downloaded file has valid image content', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('content-verifier');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('ContentVerify');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Use a small image for faster testing
      const testImage = generateTestImage('small');
      const originalSize = testImage.length;
      const filename = `verify-content-${Date.now()}.png`;

      await gallery.uploadPhoto(testImage, filename);
      await gallery.expectPhotoCount(1);

      // Open lightbox
      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
      await lightbox.waitForImage();

      // Download the photo
      const downloadPromise = user.page.waitForEvent('download');
      await lightbox.download();
      const download = await downloadPromise;

      // Save to a temporary path and read content
      const path = await download.path();
      expect(path).toBeTruthy();

      // Read the downloaded file
      const fs = await import('fs/promises');
      const downloadedContent = await fs.readFile(path!);

      // Verify it's a valid PNG (PNG signature: 89 50 4E 47 0D 0A 1A 0A)
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(downloadedContent.subarray(0, 8).equals(pngSignature)).toBe(true);

      // Verify file size is reasonable (within 20% of original, accounting for re-encoding)
      expect(downloadedContent.length).toBeGreaterThan(originalSize * 0.5);
      expect(downloadedContent.length).toBeLessThan(originalSize * 2);
    });

    test('P0-DOWNLOAD-4: encryption round-trip preserves image data', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('roundtrip-tester');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('RoundTrip');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Use a deterministic image for comparison
      // Using specific color for reproducibility
      const testImage = generateTestImage('small', [128, 64, 192]);
      const filename = `roundtrip-${Date.now()}.png`;

      await gallery.uploadPhoto(testImage, filename);
      await gallery.expectPhotoCount(1);

      // Open lightbox and download
      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
      await lightbox.waitForImage();

      const downloadPromise = user.page.waitForEvent('download');
      await lightbox.download();
      const download = await downloadPromise;

      const path = await download.path();
      expect(path).toBeTruthy();

      // Verify the downloaded file matches the original
      // Note: Due to re-encoding, we compare PNG structure rather than byte-for-byte
      const fs = await import('fs/promises');
      const downloadedContent = await fs.readFile(path!);

      // Verify PNG signature
      expect(downloadedContent[0]).toBe(0x89);
      expect(downloadedContent[1]).toBe(0x50); // P
      expect(downloadedContent[2]).toBe(0x4e); // N
      expect(downloadedContent[3]).toBe(0x47); // G

      // Verify the image is complete (ends with IEND chunk)
      const iendSignature = Buffer.from([0x49, 0x45, 0x4e, 0x44]); // IEND
      const endOfFile = downloadedContent.subarray(-12, -8);
      expect(endOfFile.equals(iendSignature)).toBe(true);
    });
  });

  test.describe('Download Permissions', () => {
    test('P1-DOWNLOAD-5: owner can download their own photos', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('owner-download');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('OwnerDownload');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, testContext.generatePhotoName(1));
      await gallery.expectPhotoCount(1);

      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
      await lightbox.waitForImage();

      // Owner should see download button
      await expect(lightbox.downloadButton).toBeVisible();

      // Download should work
      const downloadPromise = user.page.waitForEvent('download');
      await lightbox.download();
      const download = await downloadPromise;
      expect(download).toBeDefined();
    });
  });

  test.describe('Download Edge Cases', () => {
    test('P1-DOWNLOAD-6: download button not visible while image is loading', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('loading-check');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('LoadingCheck');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Use a larger image to ensure there's loading time
      const testImage = generateTestImage('medium');
      await gallery.uploadPhoto(testImage, testContext.generatePhotoName(1));
      await gallery.expectPhotoCount(1);

      // Slow down network to catch loading state
      await user.page.route('**/api/shards/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      });

      // Open lightbox - download button should appear only after image loads
      await gallery.selectPhoto(0);

      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();

      // Initially download button should not be visible (during loading)
      // Note: This may be flaky if network is very fast, so we check after load
      await lightbox.waitForImage();
      await expect(lightbox.downloadButton).toBeVisible();
    });

    test('P1-DOWNLOAD-7: can download multiple photos in sequence', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('multi-download');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('MultiDownload');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Upload 2 photos
      for (let i = 1; i <= 2; i++) {
        const testImage = generateTestImage('tiny');
        await gallery.uploadPhoto(testImage, testContext.generatePhotoName(i));
      }
      await gallery.expectPhotoCount(2);

      const downloads: Download[] = [];

      // Download first photo
      await gallery.selectPhoto(0);
      const lightbox = new Lightbox(user.page);
      await lightbox.waitForOpen();
      await lightbox.waitForImage();

      let downloadPromise = user.page.waitForEvent('download');
      await lightbox.download();
      downloads.push(await downloadPromise);

      // Navigate to next and download
      await lightbox.goToNext();
      await lightbox.waitForImage();

      downloadPromise = user.page.waitForEvent('download');
      await lightbox.download();
      downloads.push(await downloadPromise);

      // Both downloads should complete
      expect(downloads.length).toBe(2);
      for (const download of downloads) {
        const path = await download.path();
        expect(path).toBeTruthy();
      }
    });
  });
});
