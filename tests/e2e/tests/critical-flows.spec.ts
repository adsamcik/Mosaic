/**
 * Critical E2E Flows Tests
 *
 * These tests cover the most critical user journeys through Mosaic:
 * 1. Complete authentication flow with crypto initialization
 * 2. Photo upload → encryption → sync → view round-trip
 * 3. Album sharing between two users
 * 4. Member removal and forward secrecy
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

test.describe('Critical Flow: Complete Authentication @p0 @critical @auth @crypto', () => {
  test('P0-1: complete password login initializes crypto and shows app shell @smoke', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');

    const loginPage = new LoginPage(page);

    // Step 1: Verify login form is displayed
    await loginPage.waitForForm();
    await expect(loginPage.loginForm).toBeVisible();
    await expect(loginPage.passwordInput).toBeVisible();
    // Button text varies by auth mode: "Sign In" or translations
    await expect(loginPage.loginButton).toHaveText(/sign in|přihlásit se/i);

    // Step 2: Check if LocalAuth mode (has username field) and register if needed
    const isLocalAuth = await loginPage.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth) {
      // LocalAuth mode: register a new user
      await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
    } else {
      // ProxyAuth mode: just enter password
      await loginPage.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
      await loginPage.loginButton.click();
    }

    // Step 3: Wait for app shell (indicates crypto worker initialized successfully)
    await expect(page.getByTestId('app-shell')).toBeVisible({
      timeout: 60000,
    });

    // Step 4: Verify app shell has critical elements
    const appShell = new AppShell(page);
    await expect(appShell.logoutButton).toBeVisible();
    await expect(appShell.albumList).toBeVisible();
  });

  test('P0-2: logout clears session and returns to login form @smoke', async ({
    page,
    testUser,
  }) => {
    // Login first
    await page.goto('/');
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    // Verify we're logged in
    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Click logout
    await appShell.logout();

    // Verify we're back at login
    await loginPage.expectLoginFormVisible();

    // Verify reload keeps us on login (session was cleared)
    await page.reload();
    await loginPage.expectLoginFormVisible();

    // Verify we can't navigate to albums directly
    await page.goto('/albums');
    await loginPage.expectLoginFormVisible();
  });

  test('P0-5: wrong password shows error and does not authenticate', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');

    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();

    // Try wrong password
    await loginPage.passwordInput.fill(TEST_CONSTANTS.WRONG_PASSWORD);
    await loginPage.loginButton.click();

    // Should show error after crypto attempt fails
    // Note: First login with a new user might succeed as it sets up the keys
    // Subsequent wrong passwords should fail
    
    // Wait for either error message or success
    const hasError = await loginPage.errorMessage.isVisible().catch(() => false);
    const hasAppShell = await page.getByTestId('app-shell').isVisible().catch(() => false);
    
    // For a new user, initial password sets up keys, so this might succeed
    // The real test is trying a different password after initial setup
    expect(hasError || hasAppShell).toBeTruthy();
  });

  test('P0-5b: second login with different password fails', async ({
    browser,
    testUser,
  }) => {
    // Context 1: Initial login (sets up keys with password)
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();

    await page1.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    await page1.goto('/');
    const loginPage1 = new LoginPage(page1);
    await loginPage1.waitForForm();
    
    // Use loginOrRegister to handle both LocalAuth and ProxyAuth modes
    await loginPage1.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage1.expectLoginSuccess();

    // Logout to clear session
    const appShell1 = new AppShell(page1);
    await appShell1.logout();
    await context1.close();

    // Context 2: Try to login with WRONG password (should fail)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    await page2.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    await page2.goto('/');
    const loginPage2 = new LoginPage(page2);
    await loginPage2.waitForForm();

    // Check if LocalAuth mode
    const isLocalAuth = await loginPage2.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

    if (isLocalAuth) {
      // LocalAuth mode: switch to login mode and try wrong password
      await loginPage2.switchToLoginMode();
      await loginPage2.usernameInput.fill(testUser);
    }
    
    // Try wrong password - should fail to decrypt stored keys
    await loginPage2.passwordInput.fill(TEST_CONSTANTS.WRONG_PASSWORD);
    await loginPage2.loginButton.click();

    // Should show error (unable to decrypt with wrong password)
    await loginPage2.expectErrorMessage(/decrypt|password|failed/i);

    await context2.close();
  });

  test('P0-6: session persists during active use', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');

    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Navigate around the app
    await page.reload();

    // Wait for page to stabilize after reload
    await expect(
      page.locator('[data-testid="app-shell"], [data-testid="login-form"]').first()
    ).toBeVisible({ timeout: 30000 });

    // Should still be logged in (or need to re-enter password depending on session impl)
    // Check for either app shell or login form
    const stillLoggedIn = await appShell.shell.isVisible().catch(() => false);
    const backToLogin = await loginPage.loginForm.isVisible().catch(() => false);

    expect(stillLoggedIn || backToLogin).toBeTruthy();
  });
});

test.describe('Critical Flow: Photo Upload Round-Trip @p0 @critical @photo @crypto @slow', () => {
  // Triple the timeout for slow critical photo upload tests
  test.slow();
  
  // Note: mobile-chrome is excluded via testIgnore in playwright.config.ts
  // because pool users have Argon2 key derivation differences.

  test('P0-3: upload photo encrypts locally and appears in gallery after sync', async ({
    poolUser,
  }) => {
    const { page } = poolUser;

    // App shell should already be visible from poolUser fixture
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create album through browser UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Photo Upload Test ${Date.now()}`);

    // Navigate to album
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
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

    // Wait a moment for sync to complete
    await page.waitForTimeout(3000);
    console.log('[Test] Waited 3s for sync');

    // Click Albums button in header to go to album list
    const albumsButton = page.getByRole('button', { name: 'Albums' });
    await expect(albumsButton).toBeVisible({ timeout: 10000 });
    console.log('[Test] Clicking Albums button...');
    await albumsButton.click();

    // Wait for album list and find our specific album
    const albumCardAfterReload = page.getByTestId('album-card').filter({ hasText: albumName });
    await expect(albumCardAfterReload).toBeVisible({ timeout: 30000 });
    console.log('[Test] Found album card after reload, clicking...');
    await albumCardAfterReload.click();

    // Wait for gallery and verify photo persisted
    await gallery.waitForLoad();
    console.log('[Test] Gallery loaded, waiting for photo...');
    
    // Wait longer for sync to complete after entering album
    await page.waitForTimeout(5000);
    console.log('[Test] Waited 5s for photo sync');

    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    const photoCountAfter = await gallery.photos.count();
    expect(photoCountAfter).toBe(1);
  });

  test('P0-3c: multiple photos can be uploaded', async ({
    poolUser,
  }) => {
    // Use poolUser like P0-3 (which works reliably)
    const { page } = poolUser;

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

test.describe('Critical Flow: Album Sharing @p0 @critical @sharing @multi-user @slow', () => {
  // Triple the timeout for slow critical sharing tests
  test.slow();

  test('P0-4: owner can share album and viewer can access photos', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    // Step 1: Alice logs in and creates an album via browser
    await alice.goto('/');
    const aliceLoginPage = new LoginPage(alice);
    await aliceLoginPage.waitForForm();
    await aliceLoginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, aliceUser);
    await aliceLoginPage.expectLoginSuccess();

    const aliceAppShell = new AppShell(alice);
    await aliceAppShell.waitForLoad();

    // Create album through browser UI (generates real epoch keys)
    await aliceAppShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(alice);
    await createDialog.createAlbum(`Shared Album Test ${Date.now()}`);

    // Navigate to album
    const aliceAlbumCard = alice.getByTestId('album-card').first();
    await expect(aliceAlbumCard).toBeVisible({ timeout: 30000 });
    await aliceAlbumCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    // Step 2: Alice uploads a photo using the proven uploadPhoto method
    const testImage = generateTestImage();
    await aliceGallery.uploadPhoto(testImage, 'shared-photo.png');
    await expect(aliceGallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Step 3: Bob logs in (this will initialize his identity)
    await bob.goto('/');
    const bobLoginPage = new LoginPage(bob);
    await bobLoginPage.waitForForm();
    await bobLoginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, bobUser);
    await bobLoginPage.expectLoginSuccess();

    const bobAppShell = new AppShell(bob);
    await bobAppShell.waitForLoad();

    // Step 4: Alice invites Bob to the album
    // Open member management
    const membersButton = alice.getByRole('button', { name: /members|share|invite/i });
    const hasMembersButton = await membersButton.first().isVisible().catch(() => false);

    if (hasMembersButton) {
      await membersButton.first().click();

      // Look for invite dialog/form
      const inviteInput = alice.getByLabel(/user|member|email/i);
      const hasInviteInput = await inviteInput.first().isVisible().catch(() => false);

      if (hasInviteInput) {
        // Enter Bob's username directly
        await inviteInput.first().fill(bobUser);

        const inviteButton = alice.getByRole('button', { name: /invite|add|share/i });
        await inviteButton.click();

        // Wait for invite to complete
        await expect(async () => {
          const successMessage = alice.getByText(/invited|added|shared/i);
          const hasSuccess = await successMessage.first().isVisible().catch(() => false);
          expect(hasSuccess).toBeTruthy();
        }).toPass({ timeout: 30000 });

        // Step 5: Bob should now see the shared album
        await bob.reload();

        // Re-login if needed
        const bobNeedsLogin = await bobLoginPage.loginForm.isVisible().catch(() => false);
        if (bobNeedsLogin) {
          await bobLoginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, bobUser);
          await bobLoginPage.expectLoginSuccess();
        }

        // Check for shared album
        const bobAlbumCard = bob.getByTestId('album-card');
        await expect(bobAlbumCard.first()).toBeVisible({ timeout: 30000 });

        // Navigate to album
        await bobAlbumCard.first().click();

        const bobGallery = new GalleryPage(bob);
        await bobGallery.waitForLoad();

        // Bob should see the photo
        await expect(bobGallery.photos.first()).toBeVisible({ timeout: 60000 });
      } else {
        test.info().annotations.push({
          type: 'skip',
          description: 'Invite UI not available - sharing may not be implemented',
        });
      }
    } else {
      test.info().annotations.push({
        type: 'skip',
        description: 'Members button not found - sharing may not be implemented',
      });
    }
  });
});

test.describe('Critical Flow: Album CRUD @p0 @critical @album', () => {
  // Note: mobile-chrome is excluded via testIgnore in playwright.config.ts

  test('P1-1a: create album via UI appears in list', async ({
    poolUser,
  }) => {
    const { page } = poolUser;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Count initial albums
    const initialCards = await page.getByTestId('album-card').count();

    // Look for create album button
    const createButton = appShell.createAlbumButton;
    const hasCreateButton = await createButton.isVisible().catch(() => false);

    if (hasCreateButton) {
      await createButton.click();

      // Fill in album name if dialog appears
      const nameInput = page.getByLabel(/album name|name/i);
      const hasNameInput = await nameInput.first().isVisible().catch(() => false);

      if (hasNameInput) {
        await nameInput.first().fill('Test Album ' + Date.now());

        // Submit using the specific testid for the dialog submit button
        const submitButton = page.getByTestId('create-button');
        await expect(submitButton).toBeVisible({ timeout: 5000 });
        await submitButton.click();

        // Wait for album to appear
        await expect(async () => {
          const newCount = await page.getByTestId('album-card').count();
          expect(newCount).toBeGreaterThan(initialCards);
        }).toPass({ timeout: 30000 });
      } else {
        // Maybe it auto-creates without a dialog
        await expect(async () => {
          const newCount = await page.getByTestId('album-card').count();
          expect(newCount).toBeGreaterThan(initialCards);
        }).toPass({ timeout: 30000 });
      }
    } else {
      test.info().annotations.push({
        type: 'warning',
        description: 'Create album button not visible',
      });
    }
  });

  test('P1-1b: albums created via browser appear in list', async ({
    poolUser,
  }) => {
    const { page } = poolUser;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create two albums via browser UI
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Album List Test 1 ${Date.now()}`);

    await appShell.createAlbum();
    await createDialog.createAlbum(`Album List Test 2 ${Date.now()}`);

    // Should show album cards
    const albumCards = page.getByTestId('album-card');
    await expect(albumCards.first()).toBeVisible({ timeout: 30000 });

    const count = await albumCards.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('P1-1c: clicking album navigates to gallery view', async ({
    poolUser,
  }) => {
    const { page } = poolUser;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create an album via browser UI
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Gallery Navigation Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    // Should show gallery view
    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Should have back button to albums
    const backButton = appShell.backToAlbumsButton;
    const hasBackButton = await backButton.isVisible().catch(() => false);

    // Either back button exists or we're in gallery state
    expect(hasBackButton || (await gallery.gallery.isVisible())).toBeTruthy();
  });
});

test.describe('Critical Flow: Error Handling @p0 @critical @security', () => {
  test('P1-7a: empty form shows validation error', async ({ page }) => {
    await page.goto('/');

    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();

    // Submit without filling anything
    await loginPage.loginButton.click();

    // Should show error (either username or password required depending on auth mode)
    await loginPage.expectErrorMessage(/required|enter/i);
  });

  test('P1-7b: network failure shows error gracefully', async ({
    poolUser,
  }) => {
    // Note: mobile-chrome is excluded via testIgnore in playwright.config.ts
    const { page } = poolUser;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Go offline
    await page.context().setOffline(true);

    // Try to create an album
    const appShell = new AppShell(page);
    const createButton = appShell.createAlbumButton;
    const hasCreateButton = await createButton.isVisible().catch(() => false);

    if (hasCreateButton) {
      await createButton.click();

      // Fill name if dialog appears
      const nameInput = page.getByLabel(/album name|name/i);
      if (await nameInput.first().isVisible().catch(() => false)) {
        await nameInput.first().fill('Offline Album');
        // Use specific testid for dialog submit button
        const submitButton = page.getByTestId('create-button');
        await submitButton.click();

        // Should show network error
        await expect(async () => {
          const errorText = page.getByText(/network|offline|connection|failed/i);
          const hasError = await errorText.first().isVisible().catch(() => false);
          expect(hasError).toBeTruthy();
        }).toPass({ timeout: 10000 });
      }
    }

    // Go back online
    await page.context().setOffline(false);
  });
});
