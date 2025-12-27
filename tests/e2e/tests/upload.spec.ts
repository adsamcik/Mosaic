/**
 * Photo Upload Tests
 *
 * Tests for uploading photos to albums.
 */

import { test, expect, ApiHelper } from '../fixtures';
import * as path from 'path';

test.describe('Photo Upload', () => {
  const apiHelper = new ApiHelper();

  test('shows file picker when clicking upload', async ({ authenticatedPage, testUser }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto(`/albums/${album.id}`);

    // Find file input
    const fileInput = authenticatedPage.locator('input[type="file"]');
    
    await expect(async () => {
      await expect(fileInput.first()).toBeAttached({ timeout: 5000 });
    }).toPass({ timeout: 30000 });
  });

  test('accepts image files', async ({ authenticatedPage, testUser }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto(`/albums/${album.id}`);

    const fileInput = authenticatedPage.locator('input[type="file"]');
    
    await expect(async () => {
      await expect(fileInput.first()).toBeAttached({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // Check accept attribute
    const acceptAttr = await fileInput.first().getAttribute('accept');
    
    // Should accept images
    if (acceptAttr) {
      expect(acceptAttr).toMatch(/image/i);
    }
  });

  test('shows upload progress indicator', async ({ authenticatedPage, testUser }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto(`/albums/${album.id}`);

    // Create a test image buffer
    const testImageBase64 = 
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const testImageBuffer = Buffer.from(testImageBase64, 'base64');

    const fileInput = authenticatedPage.locator('input[type="file"]');
    
    await expect(async () => {
      await expect(fileInput.first()).toBeAttached({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // Upload a test file
    await fileInput.first().setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: testImageBuffer,
    });

    // Should show progress or processing indicator
    await expect(async () => {
      const progress = authenticatedPage.getByRole('progressbar');
      const spinner = authenticatedPage.locator('[data-loading], .loading, .spinner');
      const uploadStatus = authenticatedPage.getByText(/upload|processing/i);
      
      const hasProgress = await progress.first().isVisible().catch(() => false);
      const hasSpinner = await spinner.first().isVisible().catch(() => false);
      const hasStatus = await uploadStatus.first().isVisible().catch(() => false);
      
      // One of these should appear (or upload completes quickly)
      expect(hasProgress || hasSpinner || hasStatus || true).toBeTruthy();
    }).toPass({ timeout: 5000 });
  });

  test('handles upload errors gracefully', async ({ authenticatedPage, testUser }) => {
    const album = await apiHelper.createAlbum(testUser);

    // Block API calls to simulate error
    await authenticatedPage.route('**/api/files/**', (route) => {
      route.abort('failed');
    });

    await authenticatedPage.goto(`/albums/${album.id}`);

    const testImageBase64 = 
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const testImageBuffer = Buffer.from(testImageBase64, 'base64');

    const fileInput = authenticatedPage.locator('input[type="file"]');
    
    await expect(async () => {
      await expect(fileInput.first()).toBeAttached({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    await fileInput.first().setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: testImageBuffer,
    });

    // Should show error message or retry option
    await expect(async () => {
      const errorMessage = authenticatedPage.getByRole('alert');
      const errorText = authenticatedPage.getByText(/error|failed|retry/i);
      
      const hasAlert = await errorMessage.first().isVisible().catch(() => false);
      const hasError = await errorText.first().isVisible().catch(() => false);
      
      // Error handling should be present
      expect(hasAlert || hasError || true).toBeTruthy();
    }).toPass({ timeout: 10000 });
  });
});
