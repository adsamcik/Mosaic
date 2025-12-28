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

test.describe('Identity Persistence: Epoch Key Decryption After Reload', () => {
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

      // Complete login through browser UI
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Create album through browser UI
      await appShell.createAlbum();

      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum('Identity Test Album');

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

      // ========== PHASE 3: Reload page and re-authenticate ==========
      console.log('[TEST] Phase 3: Reloading page and re-authenticating');

      // Hard reload to simulate page refresh
      await page.reload({ waitUntil: 'networkidle' });

      // Check if we need to re-login
      const needsLogin = await loginPage.loginForm.isVisible().catch(() => false);
      
      if (needsLogin) {
        console.log('[TEST] Re-login required after reload');
        await loginPage.login(TEST_CONSTANTS.PASSWORD);
        await loginPage.expectLoginSuccess();
      } else {
        console.log('[TEST] Session persisted, no re-login needed');
      }

      // Navigate back to the album if we were logged out
      const appShellVisible = await appShell.shell.isVisible().catch(() => false);
      if (appShellVisible) {
        // We should be in app shell, navigate to album
        const card = page.getByTestId('album-card').first();
        await expect(card).toBeVisible({ timeout: 30000 });
        await card.click();
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
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Wait a moment for the identity to be registered
      await page.waitForTimeout(2000);

      const firstPubkeyDisplay = capturedPubkeys.first ? capturedPubkeys.first.substring(0, 20) : 'not set';
      console.log(`[TEST] First identity pubkey: ${firstPubkeyDisplay}...`);

      // ========== PHASE 2: Logout and re-login ==========
      console.log('[TEST] Phase 2: Logging out');

      await appShell.logout();
      await loginPage.expectLoginFormVisible();

      console.log('[TEST] Phase 3: Re-logging in');

      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();
      await appShell.waitForLoad();

      // Wait for the second /api/users/me call
      await page.waitForTimeout(2000);

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

      // Check for wrapped-key PUT request
      if (url.includes('/api/users/me/wrapped-key') && method === 'PUT') {
        console.log('[TEST] Wrapped key being stored on server');
        wrappedKeyStored = true;
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
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      // Wait for wrapped key to be stored
      await page.waitForTimeout(3000);

      expect(wrappedKeyStored).toBe(true);
      console.log('[TEST] SUCCESS: Wrapped account key was stored on first login');

      // Logout and login again - wrapped key should be returned
      wrappedKeyStored = false; // Reset for second login
      await appShell.logout();
      await loginPage.expectLoginFormVisible();

      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      await page.waitForTimeout(2000);

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
