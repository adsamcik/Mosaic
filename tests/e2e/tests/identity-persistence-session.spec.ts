/**
 * Identity Persistence E2E Tests - Session Tests
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
} from '../fixtures-enhanced';
import { waitForCondition, waitForNetworkIdle } from '../framework';
import { CRYPTO_TIMEOUT, NETWORK_TIMEOUT, UI_TIMEOUT } from '../framework/timeouts';
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

test.describe('Identity Persistence: Session Tests @p1 @auth @crypto @slow', () => {
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
      await expect(albumCard).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });

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
      await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

      const photoCountBefore = await gallery.photos.count();
      expect(photoCountBefore).toBeGreaterThanOrEqual(1);

      console.log(`[TEST] Photo uploaded successfully. Count: ${photoCountBefore}`);
      
      // Wait for all API calls to complete (manifest creation, sync)
      await waitForNetworkIdle(page, { timeout: NETWORK_TIMEOUT.NAVIGATION, urlPattern: /\/api\// });

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
        // Wait for app shell to fully load after login
        await appShell.waitForLoad();
      } else {
        console.log('[TEST] Session persisted, no re-login needed');
        // Even with session restore, wait for app to fully initialize
        await appShell.waitForLoad();
      }

      // Wait for album list to finish loading (either cards appear or empty state)
      // This ensures the /api/albums call has completed before we check for album-card
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
        console.log('[TEST] Network did not become fully idle, continuing...');
      });

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
      await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

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
        { timeout: UI_TIMEOUT.DIALOG, message: 'Identity pubkey not captured from first login' }
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
        { timeout: UI_TIMEOUT.DIALOG, message: 'Identity pubkey not captured from second login' }
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
        // Continue without fetching response - we only need to detect the request
        await route.continue({ headers });
        return;
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
        // Continue without fetching - request body inspection is done
        await route.continue({ headers });
        return;
      }

      // For /api/users/me GET, we need to inspect the response
      if (url.includes('/api/users/me') && method === 'GET') {
        const response = await route.fetch({ headers });
        const responseBody = await response.text();

        try {
          const userData = JSON.parse(responseBody);
          if (userData.wrappedAccountKey) {
            console.log('[TEST] Wrapped account key returned from server');
            wrappedKeyReturned = true;
          }
        } catch {
          // Ignore parse errors
        }

        await route.fulfill({
          response,
          body: responseBody,
        });
        return;
      }

      // All other requests - just continue with headers (fastest path)
      await route.continue({ headers });
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
        { timeout: CRYPTO_TIMEOUT.KEY_DERIVATION, message: 'Wrapped account key was not stored on first login' }
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
        { timeout: UI_TIMEOUT.DIALOG, message: 'Wrapped account key was not returned on second login' }
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
});
