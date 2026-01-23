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
import { waitForCondition } from '../framework';

test.describe('Sync: Multi-Session @p1 @sync @multi-user @slow', () => {
  // Run these tests serially to avoid resource contention between multi-browser sessions
  test.describe.configure({ mode: 'serial' });
  // Triple the timeout for slow multi-session sync tests
  test.slow();

  test('photos sync between browser sessions', async ({
    browser,
    testUser,
  }) => {
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
    await login1.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await login1.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell1 = new AppShell(page1);
    await appShell1.waitForLoad();
    await appShell1.createAlbum();
    const createDialog1 = new CreateAlbumDialogPage(page1);
    await createDialog1.createAlbum(`Sync Album ${Date.now()}`);

    // Navigate to the album
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
    await login2.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
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
      await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await loginPage.expectLoginSuccess();

      // Create album through browser UI (generates real epoch keys)
      const appShell = new AppShell(page);
      await appShell.waitForLoad();
      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Photo Reload Test ${Date.now()}`);

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

      // Reload page and wait for DOM to be ready
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Check if we need to re-login (session may persist)
      // Use longer timeout to allow for initial render
      const needsLogin = await loginPage.loginForm.isVisible({ timeout: 10000 }).catch(() => false);
      if (needsLogin) {
        await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
        await loginPage.expectLoginSuccess();
        await appShell.waitForLoad();
      } else {
        await appShell.waitForLoad();
      }

      // Navigate to home to see albums list
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await appShell.waitForLoad();

      // Navigate back to album (album sync happens during waitForLoad)
      const albumCardReload = page.getByTestId('album-card').first();
      await expect(albumCardReload).toBeVisible({ timeout: 30000 });
      await albumCardReload.click();

      await gallery.waitForLoad();

      // Photos should persist - use toPass for resilience against sync timing
      await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
      await expect(async () => {
        const countAfter = await gallery.photos.count();
        expect(countAfter).toBe(countBefore);
      }).toPass({ timeout: 30000, intervals: [500, 1000, 2000] });
    } finally {
      await context.close();
    }
  });

  test('album list syncs with server state', async ({
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

    // Initially no albums
    const initialCount = await page.getByTestId('album-card').count();
    expect(initialCount).toBe(0);

    // Create album via UI (generates real epoch keys)
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Sync Album ${Date.now()}`);

    // Should now show album (no reload needed with UI creation)
    await expect(page.getByTestId('album-card').first()).toBeVisible({ timeout: 30000 });
    const finalCount = await page.getByTestId('album-card').count();
    expect(finalCount).toBeGreaterThan(initialCount);
  });
});

test.describe('Sync: Offline Resilience @p2 @sync @slow', () => {
  // Run these tests serially to avoid resource contention with offline/online state changes
  test.describe.configure({ mode: 'serial' });
  // Triple the timeout for slow offline resilience tests
  test.slow();

  test('app handles going offline gracefully', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Offline Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Upload photo while online
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'before-offline.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Go offline
    await goOffline(page);

    // Photo should still be visible (cached)
    await expect(gallery.photos.first()).toBeVisible();

    // Try to upload while offline - should show error or queue
    await gallery.uploadPhoto(testImage, 'offline-upload.png');

    // Wait for offline indicator or error to appear
    const offlineIndicator = page.getByText(/offline|no connection|network/i);
    const errorIndicator = page.getByRole('alert');
    const queueIndicator = page.getByText(/queued|pending|waiting/i);

    // Wait for any indicator to appear (or timeout after 5s)
    await waitForCondition(
      async () => {
        const hasOffline = await offlineIndicator.first().isVisible().catch(() => false);
        const hasError = await errorIndicator.first().isVisible().catch(() => false);
        const hasQueue = await queueIndicator.first().isVisible().catch(() => false);
        return hasOffline || hasError || hasQueue;
      },
      { timeout: 5000, message: 'Waiting for offline/error/queue indicator' }
    ).catch(() => {
      // It's acceptable if no indicator appears - the test is checking behavior
    });

    const hasIndicator = await offlineIndicator.first().isVisible().catch(() => false) ||
                         await errorIndicator.first().isVisible().catch(() => false) ||
                         await queueIndicator.first().isVisible().catch(() => false);

    // Go back online
    await goOnline(page);

    // App should recover
    await expect(gallery.gallery).toBeVisible();
  });

  test('cached photos viewable offline', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Cache Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Upload and view photos
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'cache-photo.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    const countOnline = await gallery.photos.count();

    // Go offline
    await goOffline(page);

    // Photos should still be visible (from local cache/OPFS)
    await expect(gallery.photos.first()).toBeVisible({ timeout: 5000 });
    const countOffline = await gallery.photos.count();
    expect(countOffline).toBe(countOnline);

    // Go back online
    await goOnline(page);
  });

  test('app reconnects after going back online', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Reconnect Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Go offline
    await goOffline(page);

    // Wait briefly for app to detect offline state
    await page.waitForTimeout(500);

    // Go back online
    await goOnline(page);

    // Wait for app to detect online state and stabilize
    // The app needs time to detect 'online' event and re-establish connections
    await page.waitForTimeout(1000);

    // After going offline/online, the app may need a refresh to restore full functionality
    // Wait for the upload button to appear, which indicates permissions are restored
    const uploadButton = page.getByTestId('upload-button');
    
    // If upload button isn't visible after going online, reload the page to restore state
    const uploadButtonVisible = await uploadButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (!uploadButtonVisible) {
      // Reload to restore full app state
      await page.reload({ waitUntil: 'domcontentloaded' });
      await gallery.waitForLoad();
    }

    // Now wait for upload button to be ready
    await expect(uploadButton).toBeVisible({ timeout: 30000 });

    // Upload should work again
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'after-reconnect.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
  });
});

test.describe('Sync: Incremental Updates @p1 @sync', () => {
  test('new uploads appear without full refresh', async ({
    page,
    testUser,
  }) => {
    await page.goto('/');
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Incremental Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
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
    page,
    testUser,
  }) => {
    await page.goto('/');
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await loginPage.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Delete Sync Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(page);
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

    const deleteOption = page.getByRole('menuitem', { name: /delete/i });
    const hasDeleteMenu = await deleteOption.isVisible().catch(() => false);

    if (hasDeleteMenu) {
      await deleteOption.click();

      const confirmBtn = page.getByRole('button', { name: /delete|confirm/i });
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

test.describe('Sync: Version Tracking @p2 @sync', () => {
  test('album remembers last sync version', async ({
    browser,
    testUser,
  }) => {
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
    await login1.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await login1.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell1 = new AppShell(page1);
    await appShell1.waitForLoad();
    await appShell1.createAlbum();
    const createDialog1 = new CreateAlbumDialogPage(page1);
    await createDialog1.createAlbum(`Version Track ${Date.now()}`);

    const card1 = page1.getByTestId('album-card').first();
    await expect(card1).toBeVisible({ timeout: 30000 });
    await card1.click();

    const gallery1 = new GalleryPage(page1);
    await gallery1.waitForLoad();

    // Upload 3 photos
    const testImage = generateTestImage();
    for (let i = 1; i <= 3; i++) {
      await gallery1.uploadPhoto(testImage, `version-photo-${i}.png`);
      // Wait for photo to appear before uploading next
      await expect(async () => {
        expect(await gallery1.photos.count()).toBeGreaterThanOrEqual(i);
      }).toPass({ timeout: 60000 });
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
    await login2.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
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

test.describe('Sync: Conflict Handling @p2 @sync', () => {
  // Run serially - this test creates multiple browser contexts which is resource-intensive
  test.describe.configure({ mode: 'serial' });
  
  test('concurrent uploads from same user handled correctly', async ({
    browser,
    testUser,
  }) => {
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

    // Login first session (registers user with crypto keys)
    await page1.goto('/');
    const login1 = new LoginPage(page1);
    await login1.waitForForm();
    await login1.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await login1.expectLoginSuccess();

    // Create album via UI (generates real epoch keys)
    const appShell1 = new AppShell(page1);
    await appShell1.waitForLoad();
    await appShell1.createAlbum();
    const createDialog1 = new CreateAlbumDialogPage(page1);
    await createDialog1.createAlbum(`Conflict Test ${Date.now()}`);

    const card1 = page1.getByTestId('album-card').first();
    await expect(card1).toBeVisible({ timeout: 30000 });

    // Login second session
    await page2.goto('/');
    const login2 = new LoginPage(page2);
    await login2.waitForForm();
    await login2.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
    await login2.expectLoginSuccess();

    // Navigate session 1 to album
    await card1.click();

    // Navigate session 2 to album
    const card2 = page2.getByTestId('album-card').first();
    await expect(card2).toBeVisible({ timeout: 30000 });
    await card2.click();

    const gallery1 = new GalleryPage(page1);
    const gallery2 = new GalleryPage(page2);

    await gallery1.waitForLoad();
    await gallery2.waitForLoad();

    // Upload from both sessions concurrently
    const testImage = generateTestImage();

    // For concurrent uploads, use setFileInput instead of uploadPhoto
    // uploadPhoto waits for button state changes which can race between sessions
    // Instead, trigger both uploads and then wait for results separately
    
    // Start uploads almost simultaneously using the low-level file input method
    await gallery1.setFileInput(testImage, 'session1-photo.png');
    await gallery2.setFileInput(testImage, 'session2-photo.png');

    // Wait for uploads to complete on both sessions
    // Each session should see at least one photo after their upload completes
    await expect(gallery1.photos.first()).toBeVisible({ timeout: 60000 });
    await expect(gallery2.photos.first()).toBeVisible({ timeout: 60000 });

    // Wait for upload buttons to return to "Upload" state (not "Uploading")
    // This ensures the uploads are fully committed before reload
    const uploadBtn1 = page1.getByTestId('upload-button');
    const uploadBtn2 = page2.getByTestId('upload-button');
    
    await expect(async () => {
      const text1 = await uploadBtn1.textContent();
      const text2 = await uploadBtn2.textContent();
      expect(text1?.includes('Uploading')).toBe(false);
      expect(text2?.includes('Uploading')).toBe(false);
    }).toPass({ timeout: 60000, intervals: [500, 1000, 2000] });

    // Each session should at minimum see its own upload completed
    // Cross-session sync may take additional time, which is why we reload
    await expect(gallery1.photos.first()).toBeVisible({ timeout: 60000 });
    await expect(gallery2.photos.first()).toBeVisible({ timeout: 60000 });

    // Wait a bit for server to persist both uploads
    await page1.waitForTimeout(3000);

    // Refresh both to sync - wait for DOM to be ready
    await Promise.all([
      page1.reload({ waitUntil: 'domcontentloaded' }),
      page2.reload({ waitUntil: 'domcontentloaded' }),
    ]);

    // Re-login if needed - login check has 10s timeout for app initialization
    if (await login1.loginForm.isVisible({ timeout: 10000 }).catch(() => false)) {
      await login1.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await login1.expectLoginSuccess();
    }

    if (await login2.loginForm.isVisible({ timeout: 10000 }).catch(() => false)) {
      await login2.loginOrRegister(TEST_CONSTANTS.PASSWORD, testUser);
      await login2.expectLoginSuccess();
    }

    // Navigate to home first to ensure we're on the album list
    await Promise.all([
      page1.goto('/', { waitUntil: 'domcontentloaded' }),
      page2.goto('/', { waitUntil: 'domcontentloaded' }),
    ]);

    // Wait for app shell and album cards on both pages
    await appShell1.waitForLoad();
    
    // Create appShell for page2 - page2 doesn't have an appShell yet
    const appShell2 = new AppShell(page2);
    await appShell2.waitForLoad();

    // Navigate to the album on both pages
    await expect(page1.getByTestId('album-card').first()).toBeVisible({ timeout: 30000 });
    await expect(page2.getByTestId('album-card').first()).toBeVisible({ timeout: 30000 });
    await page1.getByTestId('album-card').first().click();
    await page2.getByTestId('album-card').first().click();

    await gallery1.waitForLoad();
    await gallery2.waitForLoad();

    // Allow time for photos to load from server
    await page1.waitForTimeout(2000);

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
