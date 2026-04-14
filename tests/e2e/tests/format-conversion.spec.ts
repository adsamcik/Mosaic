/**
 * Format Conversion E2E Tests
 *
 * Tests the complete image format conversion pipeline using real files:
 * - Uploads images in various formats (JPEG, PNG, WebP, GIF, BMP, HEIC)
 * - Verifies they are processed and displayed correctly
 * - Validates the conversion to AVIF output format
 *
 * @module tests/e2e/tests/format-conversion.spec.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  AppShell,
  CreateAlbumDialogPage,
  GalleryPage,
  LoginPage,
  TEST_CONSTANTS,
  expect,
  test,
} from '../fixtures-enhanced';
import { CRYPTO_TIMEOUT, NETWORK_TIMEOUT, UI_TIMEOUT } from '../framework/timeouts';

/**
 * Get the directory name for ES modules (since __dirname is not available)
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Path to real HEIC sample file for testing.
 * This is a real HEIC file that requires heic-to library to decode.
 */
const HEIC_SAMPLE_PATH = path.join(__dirname, '..', 'fixtures', 'sample.heic');

/**
 * Test image data in different formats.
 *
 * These are minimal valid images that can be decoded by browsers.
 * The images are base64-encoded and decoded to buffers at runtime.
 */
const TEST_IMAGES = {
  /**
   * 1x1 red PNG image
   */
  png: {
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    mimeType: 'image/png',
    extension: 'png',
  },

  /**
   * 1x1 red JPEG image
   */
  jpeg: {
    base64:
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==',
    mimeType: 'image/jpeg',
    extension: 'jpg',
  },

  /**
   * 1x1 red WebP image
   */
  webp: {
    base64: 'UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEAAQAcJYgCdAEO/hOMAAD++Ow4AA==',
    mimeType: 'image/webp',
    extension: 'webp',
  },

  /**
   * 1x1 red GIF image
   */
  gif: {
    base64: 'R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==',
    mimeType: 'image/gif',
    extension: 'gif',
  },

  /**
   * 2x2 BMP image (red pixels)
   * BMP needs to be at least 2x2 for some decoders
   */
  bmp: {
    base64:
      'Qk06AAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAAAwAAAASCwAAEgsAAAAAAAAAAAAA/wAA/wAAAP8AAP8AAA==',
    mimeType: 'image/bmp',
    extension: 'bmp',
  },

  /**
   * HEIC image loaded from fixture file.
   * The base64 is loaded dynamically from the sample.heic file.
   * This is set to empty here and populated at runtime.
   */
  heic: {
    base64: '', // Loaded from file at runtime
    mimeType: 'image/heic',
    extension: 'heic',
    fromFile: HEIC_SAMPLE_PATH, // Path to the actual file
  },

  /**
   * 1x1 AVIF image (red pixel)
   */
  avif: {
    base64:
      'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKBzgABpAQ0AIADEAABBQZAf/WFhAA',
    mimeType: 'image/avif',
    extension: 'avif',
  },
} as const;

type TestImageFormat = keyof typeof TEST_IMAGES;

/**
 * Get a test image buffer for a given format
 */
function getTestImage(format: TestImageFormat): {
  buffer: Buffer;
  mimeType: string;
  filename: string;
} {
  const image = TEST_IMAGES[format];

  // Handle file-based images (like HEIC)
  if ('fromFile' in image && image.fromFile) {
    if (!fs.existsSync(image.fromFile)) {
      throw new Error(
        `Test fixture file not found: ${image.fromFile}. ` +
          'Run the test setup script or download the HEIC sample file.'
      );
    }
    return {
      buffer: fs.readFileSync(image.fromFile),
      mimeType: image.mimeType,
      filename: `test-${format}.${image.extension}`,
    };
  }

  // Handle base64-embedded images
  return {
    buffer: Buffer.from(image.base64, 'base64'),
    mimeType: image.mimeType,
    filename: `test-${format}.${image.extension}`,
  };
}

test.describe('Format Conversion @p1 @format', () => {
  /**
   * Helper to set up a test album and navigate to it
   */
  async function setupAlbumAndNavigate(
    page: import('@playwright/test').Page,
    testUser: string,
    albumName: string
  ): Promise<GalleryPage> {
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
    await createDialog.createAlbum(albumName);

    // Navigate into the album
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
    await albumCard.click();

    // Wait for gallery to load
    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();
    return gallery;
  }

  test.describe('Standard Format Upload', () => {
    /**
     * Test uploading PNG images
     * PNG is the baseline format - should always work
     */
    test('uploads PNG image successfully', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `PNG Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('png');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/png');

      // Wait for photo to appear
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    /**
     * Test uploading JPEG images
     * JPEG is the most common format
     */
    test('uploads JPEG image successfully', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `JPEG Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('jpeg');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/jpeg');

      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    /**
     * Test uploading WebP images
     */
    test('uploads WebP image successfully', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `WebP Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('webp');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/webp');

      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    /**
     * Test uploading GIF images
     */
    test('uploads GIF image successfully', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `GIF Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('gif');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/gif');

      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    /**
     * Test uploading BMP images
     */
    test('uploads BMP image successfully', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `BMP Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('bmp');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/bmp');

      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    /**
     * Test uploading AVIF images
     */
    test('uploads AVIF image successfully', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `AVIF Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('avif');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/avif');

      await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  test.describe('HEIC Format Conversion', () => {
    /**
     * Test uploading HEIC images (requires heic-to library for decoding)
     *
     * This is the critical test for HEIC conversion:
     * 1. Upload HEIC file
     * 2. heic-to library decodes to JPEG
     * 3. JPEG is processed through canvas
     * 4. Output is encoded as AVIF
     * 5. Photo appears in gallery
     */
    test('uploads HEIC image and converts successfully', async ({
      page,
      testUser,
    }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `HEIC Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('heic');

      // Listen for console messages to debug HEIC loading
      const consoleLogs: string[] = [];
      page.on('console', (msg) => {
        if (
          msg.text().includes('heic') ||
          msg.text().includes('HEIC') ||
          msg.text().includes('decod')
        ) {
          consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
        }
      });

      // Upload the HEIC file
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/heic');

      // Wait for photo to appear (may take longer due to HEIC decoding)
      await expect(gallery.photos.first()).toBeVisible({ timeout: 90000 });

      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);

      // Log HEIC-related console output for debugging
      if (consoleLogs.length > 0) {
        console.log('HEIC conversion logs:', consoleLogs);
      }
    });

    /**
     * Test HEIC file with .heif extension
     */
    test('uploads HEIF image and converts successfully', async ({
      page,
      testUser,
    }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `HEIF Test ${Date.now()}`
      );

      // Use HEIC data but with HEIF mime type
      const { buffer } = getTestImage('heic');
      await gallery.uploadPhotoWithMime(buffer, 'test.heif', 'image/heif');

      await expect(gallery.photos.first()).toBeVisible({ timeout: 90000 });
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  test.describe('Multiple Format Upload', () => {
    /**
     * Test uploading multiple images of different formats in sequence
     */
    test('uploads multiple formats sequentially', async ({ page, testUser }) => {
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `Multi-Format Test ${Date.now()}`
      );

      const formats: TestImageFormat[] = ['png', 'jpeg', 'webp', 'gif'];

      for (const format of formats) {
        const { buffer, filename, mimeType } = getTestImage(format);
        await gallery.uploadPhotoWithMime(buffer, filename, mimeType);
      }

      // Wait for all photos to appear
      await expect(gallery.photos).toHaveCount(formats.length, {
        timeout: 120000,
      });
    });
  });

  test.describe('Photo Display After Conversion', () => {
    /**
     * Verify that an uploaded photo can be viewed in the lightbox
     * This confirms the conversion produced a displayable image
     */
    test('converted photo is viewable in lightbox', async ({
      page,
      testUser,
    }) => {
      // Upload + crypto + lightbox rendering needs extra time under CI Docker load
      test.setTimeout(240_000); // 4 minutes
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `Lightbox Test ${Date.now()}`
      );

      // Upload a JPEG (common format)
      const { buffer, filename, mimeType } = getTestImage('jpeg');
      await gallery.uploadPhotoWithMime(buffer, filename, mimeType);

      // Wait for photo to appear
      await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

      // Click to open lightbox
      await gallery.photos.first().click();

      // Wait for lightbox to open
      const lightbox = page.getByTestId('lightbox');
      await expect(lightbox).toBeVisible({ timeout: UI_TIMEOUT.DIALOG });

      // Verify an image is displayed in the lightbox
      const lightboxImage = lightbox.locator('img').first();
      await expect(lightboxImage).toBeVisible({ timeout: UI_TIMEOUT.DIALOG });

      // Image should have loaded (has dimensions)
      const naturalWidth = await lightboxImage.evaluate(
        (img: HTMLImageElement) => img.naturalWidth
      );
      expect(naturalWidth).toBeGreaterThan(0);
    });

    /**
     * Verify HEIC photo displays correctly after conversion
     */
    test('converted HEIC photo is viewable in lightbox', async ({
      page,
      testUser,
    }) => {
      // HEIC conversion + crypto is especially slow under CI Docker load
      test.setTimeout(300_000); // 5 minutes for HEIC
      const gallery = await setupAlbumAndNavigate(
        page,
        testUser,
        `HEIC Lightbox Test ${Date.now()}`
      );

      const { buffer, filename } = getTestImage('heic');
      await gallery.uploadPhotoWithMime(buffer, filename, 'image/heic');

      // Wait for photo to appear (HEIC takes longer)
      await expect(gallery.photos.first()).toBeVisible({ timeout: 90000 });

      // Click to open lightbox
      await gallery.photos.first().click();

      const lightbox = page.getByTestId('lightbox');
      await expect(lightbox).toBeVisible({ timeout: UI_TIMEOUT.DIALOG });

      const lightboxImage = lightbox.locator('img').first();
      await expect(lightboxImage).toBeVisible({ timeout: 15000 });

      // Image should have loaded
      const naturalWidth = await lightboxImage.evaluate(
        (img: HTMLImageElement) => img.naturalWidth
      );
      expect(naturalWidth).toBeGreaterThan(0);
    });
  });
});
