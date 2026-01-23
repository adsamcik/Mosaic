/**
 * Identity Persistence E2E Tests
 *
 * These tests validate that cryptographic identity (Ed25519/X25519 keypairs)
 * persists correctly across page reloads and re-authentication.
 *
 * This is critical because epoch keys are sealed to the user's identity public key.
 * If identity changes between sessions, epoch keys cannot be opened and photos
 * cannot be decrypted.
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
} from '../fixtures';
import { waitForCondition, waitForNetworkIdle } from '../framework';
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

test.describe('Identity Persistence: Epoch Key Decryption After Reload @p1 @auth @crypto @slow', () => {
  // Triple the timeout for slow identity persistence tests with crypto operations
  test.slow();

  test('P0-IDENTITY-1: photo remains accessible after page reload and re-login', async ({
    browser,
    testUser,
  }) => {
    // Create a fresh browser context
    const context = await browser.newContext();
    const page = await context.newPage();

    // Attach log collector for debugging
    const logCollector = new LogCollector(page);

    // Set up Remote-User header injection for ProxyAuth
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    try {
      // ========== PHASE 1: First login and setup ==========
      console.log('[TEST] Phase 1: Initial login and album creation');

      await page.goto('/');

      // Complete login through browser UI with unique username
      const loginPage = new LoginPage(page);
      await firstTimeLogin(page, loginPage, testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Create album through browser UI
      await appShell.createAlbum();

      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Identity Test Album ${Date.now()}`);

      // Wait for album to appear in list
      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 30000 });

      // Click to enter the album
      await albumCard.click();

      // Wait for gallery view
      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // ========== PHASE 2: Upload a photo ==========
      console.log('[TEST] Phase 2: Uploading photo');

      // Generate and upload a test image
      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'identity-test-photo.png');

      // Wait for photo to appear in gallery
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

      const photoCountBefore = await gallery.photos.count();
      expect(photoCountBefore).toBeGreaterThanOrEqual(1);

      console.log(`[TEST] Photo uploaded successfully. Count: ${photoCountBefore}`);
      
      // Wait for all API calls to complete (manifest creation, sync)
      await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      
      // Additional wait to ensure sync-complete has fired and DB is updated
      await page.waitForTimeout(500);

      // ========== PHASE 3: Reload page and re-authenticate ==========
      console.log('[TEST] Phase 3: Reloading page and re-authenticating');

      // Hard reload to simulate page refresh
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Check if we need to re-login
      const needsLogin = await loginPage.loginForm.isVisible().catch(() => false);
      
      if (needsLogin) {
        console.log('[TEST] Re-login required after reload');
        // Use loginWithUsername directly since user was just logged in and definitely exists
        await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
        await loginPage.expectLoginSuccess();
      } else {
        console.log('[TEST] Session persisted, no re-login needed');
      }

      // Check if we need to navigate to the album
      // After session restore, we might be in the album list OR already in the gallery
      const galleryVisible = await gallery.gallery.isVisible().catch(() => false);
      
      if (!galleryVisible) {
        // We're probably in the album list, navigate to album
        console.log('[TEST] Navigating to album from album list');
        const card = page.getByTestId('album-card').first();
        await expect(card).toBeVisible({ timeout: 30000 });
        await card.click();
      } else {
        console.log('[TEST] Already in gallery view after reload');
      }

      // ========== PHASE 4: Verify photo is still accessible ==========
      console.log('[TEST] Phase 4: Verifying photo accessibility');

      // Wait for gallery to load
      await gallery.waitForLoad();

      // THE CRITICAL CHECK: Can we still see the photo?
      // This fails if identity changed and epoch key cannot be decrypted
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

      const photoCountAfter = await gallery.photos.count();
      expect(photoCountAfter).toBe(photoCountBefore);

      console.log(`[TEST] SUCCESS: Photo still accessible after reload. Count: ${photoCountAfter}`);

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

  test('P0-IDENTITY-2: identity public key remains consistent across sessions', async ({
    browser,
    testUser,
  }) => {
    // Create a fresh browser context
    const context = await browser.newContext();
    const page = await context.newPage();

    const logCollector = new LogCollector(page);

    // Track identity pubkey from API responses using an object to avoid TypeScript narrowing issues
    const capturedPubkeys: { first?: string; second?: string } = {};

    // Set up Remote-User header injection AND capture /api/users/me response
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      
      // Continue the request and capture the response
      const response = await route.fetch({ headers });
      const responseBody = await response.text();

      // Log user/me responses to check identity pubkey
      if (route.request().url().includes('/api/users/me') && route.request().method() === 'GET') {
        try {
          const userData = JSON.parse(responseBody);
          const pubkeyShort = userData.identityPubkey?.substring(0, 20) ?? 'not set';
          console.log(`[TEST] /api/users/me response: identityPubkey=${pubkeyShort}...`);
          
          if (!capturedPubkeys.first && userData.identityPubkey) {
            capturedPubkeys.first = userData.identityPubkey;
          } else if (capturedPubkeys.first && userData.identityPubkey) {
            capturedPubkeys.second = userData.identityPubkey;
          }
        } catch {
          // Not JSON or parse error
        }
      }

      await route.fulfill({
        response,
        body: responseBody,
      });
    });

    try {
      // ========== PHASE 1: First login ==========
      console.log('[TEST] Phase 1: First login');

      await page.goto('/');

      const loginPage = new LoginPage(page);
      await firstTimeLogin(page, loginPage, testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Wait for identity pubkey to be captured from /api/users/me response
      await waitForCondition(
        () => capturedPubkeys.first !== undefined,
        { timeout: 10000, message: 'Identity pubkey not captured from first login' }
      );

      const firstPubkeyDisplay = capturedPubkeys.first ? capturedPubkeys.first.substring(0, 20) : 'not set';
      console.log(`[TEST] First identity pubkey: ${firstPubkeyDisplay}...`);

      // ========== PHASE 2: Logout and re-login ==========
      console.log('[TEST] Phase 2: Logging out');

      await appShell.logout();
      await loginPage.expectLoginFormVisible();

      console.log('[TEST] Phase 3: Re-logging in');

      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();
      await appShell.waitForLoad();

      // Wait for second identity pubkey to be captured from /api/users/me response
      await waitForCondition(
        () => capturedPubkeys.second !== undefined,
        { timeout: 10000, message: 'Identity pubkey not captured from second login' }
      );

      const secondPubkeyDisplay = capturedPubkeys.second ? capturedPubkeys.second.substring(0, 20) : 'not set';
      console.log(`[TEST] Second identity pubkey: ${secondPubkeyDisplay}...`);

      // ========== PHASE 3: Verify identity consistency ==========
      expect(capturedPubkeys.first).toBeDefined();
      expect(capturedPubkeys.second).toBeDefined();
      expect(capturedPubkeys.second).toBe(capturedPubkeys.first);

      console.log('[TEST] SUCCESS: Identity public key is consistent across sessions');

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

  test('P0-IDENTITY-3: wrapped account key is stored on first login', async ({
    browser,
    testUser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const logCollector = new LogCollector(page);
    let wrappedKeyStored = false;
    let wrappedKeyReturned = false;

    // Track wrapped-key API calls
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };

      const url = route.request().url();
      const method = route.request().method();

      // Check for wrapped-key PUT request (ProxyAuth mode)
      if (url.includes('/api/users/me/wrapped-key') && method === 'PUT') {
        console.log('[TEST] Wrapped key being stored on server via PUT');
        wrappedKeyStored = true;
      }
      
      // Check for wrapped key in registration request (LocalAuth mode)
      if (url.includes('/api/auth/register') && method === 'POST') {
        try {
          const postData = route.request().postData();
          if (postData) {
            const registerData = JSON.parse(postData);
            if (registerData.wrappedAccountKey) {
              console.log('[TEST] Wrapped key being stored on server via registration');
              wrappedKeyStored = true;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      const response = await route.fetch({ headers });
      const responseBody = await response.text();

      // Check if wrapped key is returned in user data
      if (url.includes('/api/users/me') && method === 'GET') {
        try {
          const userData = JSON.parse(responseBody);
          if (userData.wrappedAccountKey) {
            console.log('[TEST] Wrapped account key returned from server');
            wrappedKeyReturned = true;
          }
        } catch {
          // Ignore parse errors
        }
      }

      await route.fulfill({
        response,
        body: responseBody,
      });
    });

    try {
      // First login - should store wrapped key
      await page.goto('/');

      const loginPage = new LoginPage(page);
      await firstTimeLogin(page, loginPage, testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Wait for wrapped key to be stored via PUT request or registration
      await waitForCondition(
        () => wrappedKeyStored,
        { timeout: 15000, message: 'Wrapped account key was not stored on first login' }
      );

      expect(wrappedKeyStored).toBe(true);
      console.log('[TEST] SUCCESS: Wrapped account key was stored on first login');

      // Logout and login again - wrapped key should be returned
      wrappedKeyStored = false; // Reset for second login
      await appShell.logout();
      await loginPage.expectLoginFormVisible();

      // Use loginWithUsername directly since user definitely exists after first login
      // Using loginOrRegister would try registration first, sending wrappedAccountKey
      // in the request even though registration fails with 409
      await loginPage.loginWithUsername(testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      // Wait for wrapped key to be returned from /api/users/me response
      await waitForCondition(
        () => wrappedKeyReturned,
        { timeout: 10000, message: 'Wrapped account key was not returned on second login' }
      );

      expect(wrappedKeyReturned).toBe(true);
      console.log('[TEST] SUCCESS: Wrapped account key was returned on subsequent login');

      // On subsequent login, we should NOT store a new wrapped key
      expect(wrappedKeyStored).toBe(false);
      console.log('[TEST] SUCCESS: No new wrapped key stored on subsequent login (key reused)');

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

      // Re-login if needed
      const needsLogin = await loginPage.loginForm.isVisible().catch(() => false);
      if (needsLogin) {
        console.log('[TEST] Re-login required after reload');
        await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
        await loginPage.expectLoginSuccess();
      }

      // Navigate back to album if needed
      // After session restore, we might be in the album list OR already in the gallery
      const galleryVisible = await gallery.gallery.isVisible().catch(() => false);

      if (!galleryVisible) {
        console.log('[TEST] Navigating to album from album list');
        const card = page.getByTestId('album-card').first();
        await expect(card).toBeVisible({ timeout: 30000 });
        await card.click();
        await gallery.waitForLoad();
      } else {
        console.log('[TEST] Already in gallery view after reload');
      }

      // Verify ALL existing photos are still visible (not just the 3rd)
      await expect(gallery.photos).toHaveCount(3, { timeout: 60000 });
      console.log(`[TEST] Verified all 3 photos visible after reload`);
      
      // Wait for any background sync to complete before starting uploads
      await waitForNetworkIdle(page, { timeout: 30000, urlPattern: /\/api\// });
      
      // Re-verify count after network idle to catch any late re-renders
      const countBeforeUpload = await gallery.photos.count();
      console.log(`[TEST] Count before phase 2 uploads: ${countBeforeUpload}`);
      expect(countBeforeUpload).toBe(3);
      
      // Small delay to let React finish any pending re-renders
      await page.waitForTimeout(1000);
      
      // Final count check
      const stableCount = await gallery.photos.count();
      console.log(`[TEST] Stable count after 1s delay: ${stableCount}`);
      expect(stableCount).toBe(3);

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

      // Re-login if needed
      const needsLoginFinal = await loginPage.loginForm.isVisible().catch(() => false);
      if (needsLoginFinal) {
        console.log('[TEST] Re-login required for final verification');
        await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
        await loginPage.expectLoginSuccess();
      }

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

      // Additional wait for logout to fully complete (session cleanup)
      await page.waitForTimeout(500);
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
