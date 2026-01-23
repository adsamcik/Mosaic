/**
 * Critical E2E Flow Tests - Photo Upload
 *
 * These tests cover the photo upload round-trip:
 * 1. Photo upload → encryption → sync → view
 * 2. Photo persistence after reload
 * 3. Multiple photo uploads
 *
 * These are P0 priority tests that must pass before any release.
 */

import {
    AppShell,
    CreateAlbumDialogPage,
    expect,
    GalleryPage,
    generateTestImage,
    LoginPage,
    test,
    TEST_CONSTANTS,
} from '../fixtures';
import { waitForNetworkIdle, getAlbumsViaAPI, deleteAlbumViaAPI } from '../framework';
import { CRYPTO_TIMEOUT, NETWORK_TIMEOUT, UI_TIMEOUT } from '../framework/timeouts';

/**
 * Clean up all albums for a user.
 * Used in afterEach hooks for tests using poolUser to prevent state accumulation.
 */
async function cleanupUserAlbums(username: string): Promise<void> {
  try {
    const albums = await getAlbumsViaAPI(username);
    for (const album of albums) {
      try {
        await deleteAlbumViaAPI(username, album.id);
      } catch (err) {
        console.warn(`[Cleanup] Failed to delete album ${album.id}: ${err}`);
      }
    }
    if (albums.length > 0) {
      console.log(`[Cleanup] Deleted ${albums.length} albums for ${username}`);
    }
  } catch (err) {
    console.warn(`[Cleanup] Failed to get albums for ${username}: ${err}`);
  }
}

test.describe('Critical Flow: Photo Upload Round-Trip @p0 @critical @photo @crypto @slow', () => {
  // Triple the timeout for slow critical photo upload tests
  test.slow();
  
  // Note: mobile-chrome is excluded via testIgnore in playwright.config.ts
  // because pool users have Argon2 key derivation differences.

  // Track current pool user for cleanup
  let currentPoolUsername: string | undefined;

  test.afterEach(async () => {
    // Clean up all albums for the pool user to prevent state accumulation
    if (currentPoolUsername) {
      await cleanupUserAlbums(currentPoolUsername);
      currentPoolUsername = undefined;
    }
  });

  test('P0-3: upload photo encrypts locally and appears in gallery after sync', async ({
    poolUser,
  }) => {
    const { page } = poolUser;
    currentPoolUsername = poolUser.username;

    // App shell should already be visible from poolUser fixture
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });

    // Create album through browser UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Photo Upload Test ${Date.now()}`);

    // Navigate to album
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
    await albumCard.click();

    // Wait for gallery
    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Initially should be empty
    const initialPhotoCount = await gallery.photos.count();
    expect(initialPhotoCount).toBe(0);

    // Generate test image
    const testImage = generateTestImage();

    // Upload the photo
    await gallery.uploadPhoto(testImage, 'test-photo.png');

    // Wait for upload to complete and photo to appear
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Verify photo count increased
    const finalPhotoCount = await gallery.photos.count();
    expect(finalPhotoCount).toBeGreaterThanOrEqual(1);
  });

  test('P0-3b: uploaded photo persists after page reload', async ({
    poolUser,
  }) => {
    // Use poolUser like P0-3 (which works reliably)
    const { page, username } = poolUser;
    currentPoolUsername = poolUser.username;

    // Enable console logging for debugging
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.text().includes('[Sync]') || msg.text().includes('photo')) {
        console.log(`[Browser ${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('response', response => {
      if (response.url().includes('/api/') && response.status() >= 400) {
        console.log(`[API Error] ${response.status()} ${response.url()}`);
      }
    });

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create album through browser UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    const albumName = `Persist Test ${Date.now()}`;
    await createDialog.createAlbum(albumName);

    // Wait for album and click into it
    const albumCard = page.getByTestId('album-card').filter({ hasText: albumName });
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Upload photo using the proven uploadPhoto method
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'persistent-photo.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    const photoCountBefore = await gallery.photos.count();
    expect(photoCountBefore).toBe(1);
    console.log('[Test] Photo uploaded successfully, count before reload:', photoCountBefore);

    // Reload page - this is the persistence test
    console.log('[Test] Reloading page...');
    await page.reload();

    // Wait for either login form or app shell
    const loginPage = new LoginPage(page);
    await expect(
      page.locator('[data-testid="app-shell"], [data-testid="login-form"]').first()
    ).toBeVisible({ timeout: 30000 });
    console.log('[Test] Page reloaded, checking login state...');

    // Check if we need to re-login
    const needsLogin = await loginPage.loginForm.isVisible().catch(() => false);
    if (needsLogin) {
      console.log('[Test] Re-login required, logging in...');
      await loginPage.login(TEST_CONSTANTS.PASSWORD, username);
      await loginPage.expectLoginSuccess();
    } else {
      console.log('[Test] No re-login needed');
    }

    // Wait for app shell to be ready
    await appShell.waitForLoad();
    console.log('[Test] App shell loaded');

    // Click Albums button in header to go to album list
    // Button visibility check has 10s timeout for sync to complete
    const albumsButton = page.getByRole('button', { name: 'Albums' });
    await expect(albumsButton).toBeVisible({ timeout: UI_TIMEOUT.DIALOG });
    console.log('[Test] Clicking Albums button...');
    await albumsButton.click();

    // Wait for album list and find our specific album
    const albumCardAfterReload = page.getByTestId('album-card').filter({ hasText: albumName });
    await expect(albumCardAfterReload).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
    console.log('[Test] Found album card after reload, clicking...');
    await albumCardAfterReload.click();

    // Wait for gallery and verify photo persisted
    await gallery.waitForLoad();
    console.log('[Test] Gallery loaded, waiting for photo sync to complete...');
    
    // Wait for sync to complete after entering album (network calls finish)
    await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
    console.log('[Test] Network idle, checking for photo');

    await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

    const photoCountAfter = await gallery.photos.count();
    expect(photoCountAfter).toBe(1);
  });

  test('P0-3c: multiple photos can be uploaded', async ({
    poolUser,
  }) => {
    // Use poolUser like P0-3 (which works reliably)
    const { page } = poolUser;
    currentPoolUsername = poolUser.username;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create album through browser UI with unique name
    const albumName = `Multi Photo Test ${Date.now()}`;
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(albumName);

    // Click the newly created album by name
    const albumCard = page.getByTestId('album-card').filter({ hasText: albumName });
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Verify album is empty initially
    const initialCount = await gallery.photos.count();
    expect(initialCount).toBe(0);

    // Upload multiple photos using the proven uploadPhoto method
    const testImage = generateTestImage();

    // Upload photo 1
    await gallery.uploadPhoto(testImage, 'photo1.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 30000 });
    expect(await gallery.photos.count()).toBeGreaterThanOrEqual(1);

    // Upload photo 2
    await gallery.uploadPhoto(testImage, 'photo2.png');
    await expect(async () => {
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 30000 });

    // Upload photo 3
    await gallery.uploadPhoto(testImage, 'photo3.png');
    await expect(async () => {
      const count = await gallery.photos.count();
      expect(count).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 30000 });
  });
});
