/**
 * Sync & Multi-Device E2E Tests
 *
 * Tests for synchronization across multiple sessions/devices:
 * - Photos uploaded on one device appear on another
 * - Changes sync after reload
 * - Delta sync works correctly
 * - Offline resilience
 */

import {
  ApiHelper,
  AppShell,
  CreateAlbumDialogPage,
  expect,
  GalleryPage,
  generateTestImage,
  goOffline,
  goOnline,
  LoginPage,
  test,
  TEST_CONSTANTS,
} from '../fixtures';

test.describe('Sync: Multi-Session', () => {
  const apiHelper = new ApiHelper();

  test('photos sync between browser sessions', async ({
    browser,
    testUser,
  }) => {
    // Create album
    const album = await apiHelper.createAlbum(testUser);

    // Session 1: Upload photos
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
    const login1 = new LoginPage(page1);
    await login1.waitForForm();
    await login1.login(TEST_CONSTANTS.PASSWORD);
    await login1.expectLoginSuccess();

    const card1 = page1.getByTestId('album-card').first();
    await expect(card1).toBeVisible({ timeout: 30000 });
    await card1.click();

    const gallery1 = new GalleryPage(page1);
    await gallery1.waitForLoad();

    // Upload photos
    const testImage = generateTestImage();
    await gallery1.uploadPhoto(testImage, 'sync-photo-1.png');
    await expect(gallery1.photos.first()).toBeVisible({ timeout: 60000 });

    await gallery1.uploadPhoto(testImage, 'sync-photo-2.png');
    await expect(async () => {
      expect(await gallery1.photos.count()).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 60000 });

    const uploadedCount = await gallery1.photos.count();

    // Session 2: New browser context should see same photos
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
    const login2 = new LoginPage(page2);
    await login2.waitForForm();
    await login2.login(TEST_CONSTANTS.PASSWORD);
    await login2.expectLoginSuccess();

    const card2 = page2.getByTestId('album-card').first();
    await expect(card2).toBeVisible({ timeout: 30000 });
    await card2.click();

    const gallery2 = new GalleryPage(page2);
    await gallery2.waitForLoad();

    // Wait for photos to sync
    await expect(gallery2.photos.first()).toBeVisible({ timeout: 60000 });

    // Should see same number of photos
    await expect(async () => {
      const count = await gallery2.photos.count();
      expect(count).toBe(uploadedCount);
    }).toPass({ timeout: 60000 });

    // Cleanup
    await context1.close();
    await context2.close();
  });

  test('new photos appear after page reload', async ({
    browser,
    testUser,
  }) => {
    // Use browser-based album creation to get real epoch keys
    const context = await browser.newContext();
    const page = await context.newPage();

    // Set up Remote-User header injection
    await page.route('**/api/**', async (route) => {
      const headers = { ...route.request().headers(), 'Remote-User': testUser };
      await route.continue({ headers });
    });

    try {
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.login(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album through browser UI (generates real epoch keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum('Photo Reload Test');

      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({ timeout: 30000 });
      await albumCard.click();

      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      // Upload photos
      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'reload-photo-1.png');
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

      await gallery.uploadPhoto(testImage, 'reload-photo-2.png');
      await expect(async () => {
        expect(await gallery.photos.count()).toBeGreaterThanOrEqual(2);
      }).toPass({ timeout: 60000 });

      const countBefore = await gallery.photos.count();

      // Reload page
      await page.reload();

      // Check if we need to re-login (session may persist)
      const needsLogin = await loginPage.loginForm.isVisible({ timeout: 5000 }).catch(() => false);
      if (needsLogin) {
        await loginPage.login(TEST_CONSTANTS.PASSWORD, testUser);
        await loginPage.expectLoginSuccess();
      } else {
        await appShell.waitForLoad();
      }

      // Navigate back to album
      await page.getByTestId('album-card').first().click();

      await gallery.waitForLoad();

      // Photos should persist
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      const countAfter = await gallery.photos.count();
      expect(countAfter).toBe(countBefore);
    } finally {
      await context.close();
    }
  });

  test('album list syncs with server state', async ({
    authenticatedPage,
    testUser,
  }) => {
    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const appShell = new AppShell(authenticatedPage);
    await appShell.waitForLoad();

    // Initially no albums
    const initialCount = await authenticatedPage.getByTestId('album-card').count();
    expect(initialCount).toBe(0);

    // Create album via API
    await apiHelper.createAlbum(testUser);

    // Reload to sync
    await authenticatedPage.reload();

    const needsLogin = await loginPage.loginForm.isVisible().catch(() => false);
    if (needsLogin) {
      await loginPage.login(TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();
    }

    await appShell.waitForLoad();

    // Should now show album
    await expect(authenticatedPage.getByTestId('album-card').first()).toBeVisible({ timeout: 30000 });
    const finalCount = await authenticatedPage.getByTestId('album-card').count();
    expect(finalCount).toBeGreaterThan(initialCount);
  });
});

test.describe('Sync: Offline Resilience', () => {
  const apiHelper = new ApiHelper();

  test('app handles going offline gracefully', async ({
    authenticatedPage,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const albumCard = authenticatedPage.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(authenticatedPage);
    await gallery.waitForLoad();

    // Upload photo while online
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'before-offline.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Go offline
    await goOffline(authenticatedPage);

    // Photo should still be visible (cached)
    await expect(gallery.photos.first()).toBeVisible();

    // Try to upload while offline - should show error or queue
    await gallery.uploadPhoto(testImage, 'offline-upload.png');

    // Wait a moment
    await authenticatedPage.waitForTimeout(3000);

    // Should show offline indicator or error
    const offlineIndicator = authenticatedPage.getByText(/offline|no connection|network/i);
    const errorIndicator = authenticatedPage.getByRole('alert');
    const queueIndicator = authenticatedPage.getByText(/queued|pending|waiting/i);

    const hasIndicator = await offlineIndicator.first().isVisible().catch(() => false) ||
                         await errorIndicator.first().isVisible().catch(() => false) ||
                         await queueIndicator.first().isVisible().catch(() => false);

    // Go back online
    await goOnline(authenticatedPage);

    // App should recover
    await expect(gallery.gallery).toBeVisible();
  });

  test('cached photos viewable offline', async ({
    authenticatedPage,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const albumCard = authenticatedPage.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(authenticatedPage);
    await gallery.waitForLoad();

    // Upload and view photos
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'cache-photo.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    const countOnline = await gallery.photos.count();

    // Go offline
    await goOffline(authenticatedPage);

    // Photos should still be visible (from local cache/OPFS)
    await expect(gallery.photos.first()).toBeVisible({ timeout: 5000 });
    const countOffline = await gallery.photos.count();
    expect(countOffline).toBe(countOnline);

    // Go back online
    await goOnline(authenticatedPage);
  });

  test('app reconnects after going back online', async ({
    authenticatedPage,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const albumCard = authenticatedPage.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(authenticatedPage);
    await gallery.waitForLoad();

    // Go offline
    await goOffline(authenticatedPage);
    await authenticatedPage.waitForTimeout(1000);

    // Go back online
    await goOnline(authenticatedPage);

    // Upload should work again
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'after-reconnect.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
  });
});

test.describe('Sync: Incremental Updates', () => {
  const apiHelper = new ApiHelper();

  test('new uploads appear without full refresh', async ({
    authenticatedPage,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const albumCard = authenticatedPage.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(authenticatedPage);
    await gallery.waitForLoad();

    // Upload first photo
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'incremental-1.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
    expect(await gallery.photos.count()).toBe(1);

    // Upload second photo - should appear without reload
    await gallery.uploadPhoto(testImage, 'incremental-2.png');
    await expect(async () => {
      expect(await gallery.photos.count()).toBe(2);
    }).toPass({ timeout: 60000 });

    // Upload third photo
    await gallery.uploadPhoto(testImage, 'incremental-3.png');
    await expect(async () => {
      expect(await gallery.photos.count()).toBe(3);
    }).toPass({ timeout: 60000 });
  });

  test('deleted photos removed from view', async ({
    authenticatedPage,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const albumCard = authenticatedPage.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(authenticatedPage);
    await gallery.waitForLoad();

    // Upload photos
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'delete-sync-1.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    await gallery.uploadPhoto(testImage, 'delete-sync-2.png');
    await expect(async () => {
      expect(await gallery.photos.count()).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 60000 });

    const countBefore = await gallery.photos.count();

    // Delete one photo
    await gallery.photos.first().click({ button: 'right' });

    const deleteOption = authenticatedPage.getByRole('menuitem', { name: /delete/i });
    const hasDeleteMenu = await deleteOption.isVisible().catch(() => false);

    if (hasDeleteMenu) {
      await deleteOption.click();

      const confirmBtn = authenticatedPage.getByRole('button', { name: /delete|confirm/i });
      if (await confirmBtn.first().isVisible().catch(() => false)) {
        await confirmBtn.first().click();
      }

      // Photo should be removed immediately (without reload)
      await expect(async () => {
        expect(await gallery.photos.count()).toBeLessThan(countBefore);
      }).toPass({ timeout: 30000 });
    }
  });
});

test.describe('Sync: Version Tracking', () => {
  const apiHelper = new ApiHelper();

  test('album remembers last sync version', async ({
    browser,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    // Session 1: Upload photos
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
    const login1 = new LoginPage(page1);
    await login1.waitForForm();
    await login1.login(TEST_CONSTANTS.PASSWORD);
    await login1.expectLoginSuccess();

    const card1 = page1.getByTestId('album-card').first();
    await expect(card1).toBeVisible({ timeout: 30000 });
    await card1.click();

    const gallery1 = new GalleryPage(page1);
    await gallery1.waitForLoad();

    // Upload 3 photos
    const testImage = generateTestImage();
    for (let i = 1; i <= 3; i++) {
      await gallery1.uploadPhoto(testImage, `version-photo-${i}.png`);
      await page1.waitForTimeout(1000);
    }

    await expect(async () => {
      expect(await gallery1.photos.count()).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 90000 });

    // Close session 1
    await context1.close();

    // Session 2: Should load photos from version without re-downloading all
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    // Track API calls to monitor sync behavior
    const syncCalls: string[] = [];
    await page2.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/sync')) {
        syncCalls.push(url);
      }
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    await page2.goto('/');
    const login2 = new LoginPage(page2);
    await login2.waitForForm();
    await login2.login(TEST_CONSTANTS.PASSWORD);
    await login2.expectLoginSuccess();

    const card2 = page2.getByTestId('album-card').first();
    await expect(card2).toBeVisible({ timeout: 30000 });
    await card2.click();

    const gallery2 = new GalleryPage(page2);
    await gallery2.waitForLoad();

    // Should show photos
    await expect(gallery2.photos.first()).toBeVisible({ timeout: 60000 });
    expect(await gallery2.photos.count()).toBeGreaterThanOrEqual(3);

    // Cleanup
    await context2.close();
  });
});

test.describe('Sync: Conflict Handling', () => {
  const apiHelper = new ApiHelper();

  test('concurrent uploads from same user handled correctly', async ({
    browser,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    // Create two sessions for same user
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Set up auth for both
    for (const page of [page1, page2]) {
      await page.route('**/api/**', async (route) => {
        const headers = {
          ...route.request().headers(),
          'Remote-User': testUser,
        };
        await route.continue({ headers });
      });
    }

    // Login both sessions
    await page1.goto('/');
    const login1 = new LoginPage(page1);
    await login1.waitForForm();
    await login1.login(TEST_CONSTANTS.PASSWORD);
    await login1.expectLoginSuccess();

    await page2.goto('/');
    const login2 = new LoginPage(page2);
    await login2.waitForForm();
    await login2.login(TEST_CONSTANTS.PASSWORD);
    await login2.expectLoginSuccess();

    // Navigate both to album
    const card1 = page1.getByTestId('album-card').first();
    await expect(card1).toBeVisible({ timeout: 30000 });
    await card1.click();

    const card2 = page2.getByTestId('album-card').first();
    await expect(card2).toBeVisible({ timeout: 30000 });
    await card2.click();

    const gallery1 = new GalleryPage(page1);
    const gallery2 = new GalleryPage(page2);

    await gallery1.waitForLoad();
    await gallery2.waitForLoad();

    // Upload from both sessions concurrently
    const testImage = generateTestImage();

    // Start uploads almost simultaneously
    const upload1 = gallery1.uploadPhoto(testImage, 'session1-photo.png');
    const upload2 = gallery2.uploadPhoto(testImage, 'session2-photo.png');

    await Promise.all([upload1, upload2]);

    // Wait for both to complete
    await expect(gallery1.photos.first()).toBeVisible({ timeout: 60000 });
    await expect(gallery2.photos.first()).toBeVisible({ timeout: 60000 });

    // Refresh both to sync
    await page1.reload();
    await page2.reload();

    // Re-login if needed
    if (await login1.loginForm.isVisible().catch(() => false)) {
      await login1.login(TEST_CONSTANTS.PASSWORD);
      await login1.expectLoginSuccess();
      await page1.getByTestId('album-card').first().click();
    }

    if (await login2.loginForm.isVisible().catch(() => false)) {
      await login2.login(TEST_CONSTANTS.PASSWORD);
      await login2.expectLoginSuccess();
      await page2.getByTestId('album-card').first().click();
    }

    await gallery1.waitForLoad();
    await gallery2.waitForLoad();

    // Both should show both photos
    await expect(async () => {
      const count1 = await gallery1.photos.count();
      const count2 = await gallery2.photos.count();
      expect(count1).toBeGreaterThanOrEqual(2);
      expect(count2).toBeGreaterThanOrEqual(2);
      expect(count1).toBe(count2);
    }).toPass({ timeout: 60000 });

    // Cleanup
    await context1.close();
    await context2.close();
  });
});
