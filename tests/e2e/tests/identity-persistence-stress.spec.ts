/**
 * Identity Persistence E2E Tests - Stress and Logout Tests
 *
 * These tests validate that cryptographic identity persists correctly across
 * multiple reloads and explicit logout/re-login cycles.
 *
 * The tests use FULL BROWSER FLOW - no API shortcuts. All actions go through
 * the UI to match real user behavior.
 */

import {
  AppShell,
  CreateAlbumDialogPage,
  expect,
  GalleryPage,
  generateTestImage,
  LogCollector,
  LoginPage,
  test,
  TEST_CONSTANTS,
} from '../fixtures-enhanced';
import { waitForNetworkIdle } from '../framework';
import { CRYPTO_TIMEOUT, NETWORK_TIMEOUT } from '../framework/timeouts';
import type { Page } from '@playwright/test';

/**
 * Helper to handle first-time login for new users.
 * In LocalAuth mode, new users must register first.
 * In ProxyAuth mode, just enter password.
 */
async function firstTimeLogin(page: Page, loginPage: LoginPage, username: string, password: string): Promise<void> {
  await loginPage.waitForForm();
  
  // Detect auth mode by checking for username field
  const usernameInput = page.getByLabel(/username|uživatelské jméno/i);
  const isLocalAuth = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
  
  if (isLocalAuth) {
    // LocalAuth mode: register new user (test users are always new)
    await loginPage.register(username, password);
  } else {
    // ProxyAuth mode: just enter password
    await loginPage.login(password, username);
  }
}

test.describe('Identity Persistence: Stress and Logout Tests @p1 @auth @crypto @slow', () => {
  // Triple the timeout for slow identity persistence tests with crypto operations
  test.slow();

  test('P0-IDENTITY-STRESS: multiple uploads remain accessible across page reloads', async ({
    browser,
    testUser,
  }) => {
    /**
     * Stress test: Upload multiple photos, reload, upload more, verify all.
     * 
     * Test intent:
     * 1. Upload multiple photos (3) in one session
     * 2. Reload page and re-authenticate
     * 3. Upload more photos (2)
     * 4. Reload again and verify ALL photos are accessible
     *
     * This catches edge cases where:
     * - Epoch key rotation during upload causes issues
     * - Multiple shards with same epoch aren't properly tracked
     * - Session state leaks between uploads
     */

    const context = await browser.newContext();
    const page = await context.newPage();

    const logCollector = new LogCollector(page);

    // Set up Remote-User header injection
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    try {
      // ========== PHASE 1: First session - upload 3 photos ==========
      console.log('[TEST] Phase 1: First session - uploading 3 photos');

      await page.goto('/');

      const loginPage = new LoginPage(page);
      await firstTimeLogin(page, loginPage, testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Create album
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Stress Test Album ${Date.now()}`);

      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 30000 });
      await albumCard.click();

      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // Upload 3 photos sequentially
      for (let i = 1; i <= 3; i++) {
        const testImage = generateTestImage();
        await gallery.uploadPhoto(testImage, `stress-photo-${i}.png`);
        console.log(`[TEST] Uploaded photo ${i}/3`);
        // Wait for upload to complete via network idle
        await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      }

      // Wait for all photos to appear
      await expect(gallery.photos.nth(2)).toBeVisible({ timeout: 60000 });
      const countAfterFirstSession = await gallery.photos.count();
      expect(countAfterFirstSession).toBe(3);

      console.log(`[TEST] First session complete: ${countAfterFirstSession} photos`);

      // ========== PHASE 2: Reload and upload 2 more ==========
      console.log('[TEST] Phase 2: Reloading and uploading 2 more photos');

      await page.reload({ waitUntil: 'domcontentloaded' });

      await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);

      // Wait for app to fully initialize after login/session restore
      await appShell.waitForLoad();

      // Wait for album list to finish loading before checking for album cards
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
        console.log('[TEST] Network did not become fully idle, continuing...');
      });

      // Navigate back to album if needed
      // After session restore, we might be in the album list OR already in the gallery
      const galleryVisible = await gallery.gallery.isVisible().catch(() => false);

      if (!galleryVisible) {
        console.log('[TEST] Navigating to album from album list');
        const card = page.getByTestId('album-card').first();
        await expect(card).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
        await card.click();
        await gallery.waitForLoad();
      } else {
        console.log('[TEST] Already in gallery view after reload');
      }

      // Verify ALL existing photos are still visible (not just the 3rd)
      await expect(gallery.photos).toHaveCount(3, { timeout: CRYPTO_TIMEOUT.BATCH });
      console.log(`[TEST] Verified all 3 photos visible after reload`);
      
      // Wait for any background sync to complete before starting uploads
      await waitForNetworkIdle(page, { timeout: NETWORK_TIMEOUT.NAVIGATION, urlPattern: /\/api\// });
      
      // Re-verify count after network idle to catch any late re-renders
      const countBeforeUpload = await gallery.photos.count();
      console.log(`[TEST] Count before phase 2 uploads: ${countBeforeUpload}`);
      expect(countBeforeUpload).toBe(3);
      
      // Wait for any pending React re-renders to complete by verifying count is stable
      await expect(async () => {
        const count = await gallery.photos.count();
        expect(count).toBe(3);
      }).toPass({ timeout: 5000, intervals: [100, 200, 500] });
      console.log(`[TEST] Stable count verified: 3`);

      // Upload 2 more photos
      for (let i = 4; i <= 5; i++) {
        const testImage = generateTestImage();
        await gallery.uploadPhoto(testImage, `stress-photo-${i}.png`);
        console.log(`[TEST] Uploaded photo ${i}/5`);
        // Wait for upload to complete via network idle
        await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      }

      // Wait for all 5 photos
      await expect(gallery.photos.nth(4)).toBeVisible({ timeout: 60000 });
      const countAfterSecondSession = await gallery.photos.count();
      expect(countAfterSecondSession).toBe(5);

      console.log(`[TEST] Second session complete: ${countAfterSecondSession} photos`);

      // ========== PHASE 3: Final reload and verify all photos ==========
      console.log('[TEST] Phase 3: Final reload and verification');

      await page.reload({ waitUntil: 'domcontentloaded' });

      await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);

      // Wait for app to fully initialize after login/session restore
      await appShell.waitForLoad();

      // Wait for album list to finish loading before checking for album cards
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
        console.log('[TEST] Network did not become fully idle, continuing...');
      });

      // Navigate to gallery - check if we're already there or need to navigate
      const galleryVisibleFinal = await gallery.gallery.isVisible().catch(() => false);
      if (!galleryVisibleFinal) {
        // We're in the album list, navigate to the album
        console.log('[TEST] Navigating to album from album list for final verification');
        const card = page.getByTestId('album-card').first();
        await expect(card).toBeVisible({ timeout: 30000 });
        await card.click();
        await gallery.waitForLoad();
      } else {
        console.log('[TEST] Already in gallery view for final verification');
      }

      // THE CRITICAL CHECK: All 5 photos must be accessible
      // Use toHaveCount to properly wait for all photos, not just the 5th one
      await expect(gallery.photos).toHaveCount(5, { timeout: 60000 });
      const finalCount = await gallery.photos.count();

      console.log(`[TEST] SUCCESS: All ${finalCount} photos accessible after multiple reloads`);

    } catch (error) {
      console.error('=== BROWSER CONSOLE LOGS ===');
      console.error(logCollector.getFormattedLogs());
      console.error('=== BACKEND LOGS ===');
      console.error(LogCollector.fetchBackendLogs());
      throw error;
    } finally {
      await context.close();
    }
  });

  test('P0-IDENTITY-4: crypto survives explicit logout and re-login', async ({
    browser,
    testUser,
  }) => {
    /**
     * This test validates the most critical identity persistence scenario:
     * 1. User logs in and creates an album
     * 2. User uploads a photo (which gets encrypted with epoch key)
     * 3. User EXPLICITLY logs out (not just page reload)
     * 4. User logs back in with the same password
     * 5. User can still view the previously uploaded photo
     *
     * This is critical because:
     * - Logout clears session storage and in-memory keys
     * - Re-login must re-derive the same identity keypair from password
     * - The wrapped account key stored on server must be correctly unwrapped
     * - Epoch keys sealed to identity must be recoverable
     */

    const context = await browser.newContext();
    const page = await context.newPage();

    const logCollector = new LogCollector(page);

    // Set up Remote-User header injection for ProxyAuth
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    // Track album name for reliable navigation after re-login
    const albumName = `Logout Persistence Test Album ${Date.now()}`;

    try {
      // ========== PHASE 1: Initial login and setup ==========
      console.log('[TEST] Phase 1: Initial login and album creation');
      console.log(`[TEST] Test user: ${testUser}`);
      console.log(`[TEST] Album name: ${albumName}`);

      await page.goto('/');
      console.log('[TEST] Navigated to /');

      const loginPage = new LoginPage(page);
      await firstTimeLogin(page, loginPage, testUser, TEST_CONSTANTS.PASSWORD);
      console.log('[TEST] firstTimeLogin completed, waiting for success');
      await loginPage.expectLoginSuccess();
      console.log('[TEST] Login success confirmed');

      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      console.log('[TEST] App shell loaded');

      // Create album through browser UI
      await appShell.createAlbum();
      console.log('[TEST] Create album button clicked');

      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(albumName);
      console.log('[TEST] Album created, dialog closed');

      // Wait for album to appear and click it
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 30000 });
      console.log('[TEST] Album card visible');
      await albumCard.click();
      console.log('[TEST] Album card clicked');

      // Wait for gallery view
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();
      console.log('[TEST] Gallery loaded');

      // ========== PHASE 2: Upload a photo ==========
      console.log('[TEST] Phase 2: Uploading photo');

      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'logout-test-photo.png');
      console.log('[TEST] Upload initiated');

      // Wait for photo to appear and stabilize
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      console.log('[TEST] Photo visible');

      // Wait for network to settle after upload
      await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      console.log('[TEST] Network idle after upload');

      const photoCountBefore = await gallery.photos.count();
      expect(photoCountBefore).toBeGreaterThanOrEqual(1);

      console.log(`[TEST] Photo uploaded successfully. Count: ${photoCountBefore}`);

      // ========== PHASE 3: EXPLICIT LOGOUT ==========
      console.log('[TEST] Phase 3: Performing explicit logout');

      // Navigate back to app shell first (if needed)
      const backButton = page.getByRole('button', { name: /back|albums|zpět|alba/i });
      if (await backButton.isVisible().catch(() => false)) {
        console.log('[TEST] Back button visible, clicking');
        await backButton.click();
        await appShell.waitForLoad();
        console.log('[TEST] Navigated back to app shell');
      }

      // Click the logout button
      console.log('[TEST] Clicking logout button');
      await appShell.logout();

      // Wait for login form to appear with explicit timeout and logging
      console.log('[TEST] Waiting for login form to appear after logout');
      await expect(loginPage.loginForm).toBeVisible({ timeout: 30000 });
      console.log('[TEST] Login form visible after logout');
      
      // Verify logout is complete by waiting for network to settle
      await waitForNetworkIdle(page, { timeout: 10000, urlPattern: /\/api\// });
      console.log('[TEST] Logout complete - session cleared');

      // ========== PHASE 4: Re-login with same password ==========
      console.log('[TEST] Phase 4: Re-logging in with same password');

      // Wait for form to be stable before interacting
      await expect(loginPage.passwordInput).toBeVisible({ timeout: 10000 });
      console.log('[TEST] Password input visible');

      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      console.log('[TEST] loginOrRegister called, waiting for success');
      await loginPage.expectLoginSuccess();
      console.log('[TEST] Login success confirmed');

      await appShell.waitForLoad();
      console.log('[TEST] App shell loaded after re-login');

      // Wait for album list to populate (async fetch after login)
      await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      console.log('[TEST] Network idle after re-login');

      console.log('[TEST] Re-login successful');

      // ========== PHASE 5: Navigate back to album ==========
      console.log('[TEST] Phase 5: Navigating to album');

      // Find and click the album we created - use name for reliability
      const albumCardAfterLogin = page.getByTestId('album-card').filter({ hasText: albumName });
      console.log('[TEST] Looking for album card with name: ' + albumName);
      await expect(albumCardAfterLogin).toBeVisible({ timeout: 30000 });
      console.log('[TEST] Album card found, clicking');
      await albumCardAfterLogin.click();

      // ========== PHASE 6: Verify photo is still accessible ==========
      console.log('[TEST] Phase 6: Verifying photo accessibility after logout/re-login');

      await gallery.waitForLoad();
      console.log('[TEST] Gallery loaded after navigation');

      // Wait for crypto worker to process and photos to decrypt
      // This is critical: after re-login, the crypto system needs time to:
      // 1. Re-derive identity from password
      // 2. Fetch and unwrap account key
      // 3. Fetch and open epoch keys
      // 4. Decrypt photo thumbnails
      await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      console.log('[TEST] Network idle in gallery');

      // THE CRITICAL CHECK: Can we still see the photo after explicit logout and re-login?
      // This validates that:
      // - Identity keypair was correctly re-derived from password
      // - Wrapped account key was correctly retrieved and unwrapped
      // - Epoch key sealed to identity was correctly opened
      // - Photo shard was correctly decrypted
      console.log('[TEST] Waiting for photo to be visible');
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      console.log('[TEST] Photo visible, counting');

      const photoCountAfter = await gallery.photos.count();
      console.log(`[TEST] Photo count after re-login: ${photoCountAfter}`);
      expect(photoCountAfter).toBe(photoCountBefore);

      console.log(`[TEST] SUCCESS: Photo still accessible after explicit logout and re-login. Count: ${photoCountAfter}`);

    } catch (error) {
      // Capture logs on failure for debugging
      console.error('=== BROWSER CONSOLE LOGS ===');
      console.error(logCollector.getFormattedLogs());
      console.error('=== BACKEND LOGS ===');
      console.error(LogCollector.fetchBackendLogs());
      throw error;
    } finally {
      await context.close();
    }
  });
});
