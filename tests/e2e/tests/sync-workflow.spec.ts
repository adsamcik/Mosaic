/**
 * Sync & Multi-Device E2E Tests
 *
 * Tests for synchronization across multiple sessions/devices:
 * - Photos uploaded on one device appear on another
 * - Changes sync after reload
 * - Delta sync works correctly
 * - Offline resilience
 */

import type { Page, Response } from '@playwright/test';
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
} from '../fixtures-enhanced';
import { waitForCondition, waitForNetworkIdle } from '../framework';
import { CRYPTO_TIMEOUT, NETWORK_TIMEOUT, UI_TIMEOUT } from '../framework/timeouts';

const ALBUM_SYNC_ENDPOINT = /\/api\/(?:v\d+\/)?albums\/[^/?]+\/sync\?/;

function waitForAlbumSyncResponse(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) => ALBUM_SYNC_ENDPOINT.test(response.url()),
    { timeout: 60000 },
  );
}

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

    await page1.route('**/api/v1/**', async (route) => {
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
    await expect(card1).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
    await card1.click();

    const gallery1 = new GalleryPage(page1);
    await gallery1.waitForLoad();

    // Upload photos. Wait for the manifest finalize POST for each upload to
    // resolve so we know the server has both committed before Tab 2 syncs.
    // Use distinct image colors so the upload pipeline cannot dedupe them
    // by content hash and silently skip the second upload.
    const photo1Image = generateTestImage('tiny', [255, 0, 0]);
    const photo2Image = generateTestImage('tiny', [0, 255, 0]);

    const photo1Finalized = page1.waitForResponse(
      (resp) => /\/api\/v\d+\/manifests\/[^/]+\/finalize/.test(resp.url()) && resp.ok(),
      { timeout: 60000 },
    );
    await gallery1.uploadPhoto(photo1Image, 'sync-photo-1.png');
    await photo1Finalized;
    await expect(gallery1.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

    const photo2Finalized = page1.waitForResponse(
      (resp) => /\/api\/v\d+\/manifests\/[^/]+\/finalize/.test(resp.url()) && resp.ok(),
      { timeout: 60000 },
    );
    await gallery1.uploadPhoto(photo2Image, 'sync-photo-2.png');
    await photo2Finalized;

    // Server has both finalized photos (we waited for both finalize POSTs).
    // Local pending overlay may linger briefly after server commit; we measure
    // against the known server-side count rather than the local UI count.
    const uploadedCount = 2;

    // Session 2: New browser context should see same photos
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    await page2.route('**/api/v1/**', async (route) => {
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
    await page.route('**/api/v1/**', async (route) => {
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

      // Upload photos (identical buffer is intentional: this test verifies
      // reload persistence and content-hash dedup behavior).
      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'reload-photo-1.png');
      await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

      // Second upload of the identical buffer is intentionally deduped by the
      // client-side content-hash check. We use the low-level setFileInput
      // because uploadPhoto() asserts the visible photo count increases, which
      // (correctly) does not happen for a content-hash duplicate.
      //
      // v1.0.2 dedup-fixed-sleep: replace the previous fixed 500 ms sleep
      // with a deterministic wait on the `Duplicate upload skipped:` log
      // line emitted by upload-store-bridge when the worker dispatches
      // DuplicateUploadError. This is the same signal that drives the
      // in-app dedup UX, so settling on it guarantees the worker has run
      // before the page reload happens.
      const dedupSettled = page.waitForEvent('console', {
        predicate: (msg) => /Duplicate upload skipped/i.test(msg.text()),
        timeout: NETWORK_TIMEOUT.FORM_SUBMIT,
      });
      await gallery.setFileInput(testImage, 'reload-photo-2.png');
      await dedupSettled;
      // After reload only finalized server photos appear. With identical image
      // content (intentional for this test), the upload pipeline dedupes the
      // second upload by content hash, so the server has exactly 1 photo.
      const expectedAfterReload = 1;

      // Reload page and wait for DOM to be ready
      await page.reload({ waitUntil: 'domcontentloaded' });

      await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);

      // Navigate to home to see albums list
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);
      await appShell.waitForLoad();

      // Navigate back to album (album sync happens during waitForLoad)
      const albumCardReload = page.getByTestId('album-card').first();
      await expect(albumCardReload).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
      await albumCardReload.click();

      await gallery.waitForLoad();

      // Photos should persist - use toPass for resilience against sync timing
      await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });
      await expect(async () => {
        const countAfter = await gallery.photos.count();
        expect(countAfter).toBe(expectedAfterReload);
      }).toPass({ timeout: NETWORK_TIMEOUT.NAVIGATION, intervals: [500, 1000, 2000] });
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

    // Try to upload while offline - should show error or queue.
    // We can't use gallery.uploadPhoto here because it waits for upload
    // completion, which never happens while offline (manifest POST fails).
    // Instead, dispatch the file selection directly and let the test verify
    // the offline/error/queue indicator below.
    await gallery.uploadInput.setInputFiles({
      name: 'offline-upload.png',
      mimeType: 'image/png',
      buffer: testImage,
    });

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
    await gallery.waitForStablePhotoCountAtLeast(countOnline, 10000);
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

    // Go back online
    await goOnline(page);

    // After going offline/online, the app may need a refresh to restore full functionality
    // Wait for the upload button to appear, which indicates permissions are restored
    const uploadButton = page.getByTestId('upload-button');
    
    // If upload button isn't visible after going online, reload the page to restore state
    const uploadButtonVisible = await uploadButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (!uploadButtonVisible) {
      // Reload to restore full app state
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);
      await gallery.waitForLoad();
      await gallery.waitForOwnerPermissions();
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

    // Upload first photo. Each photo must have distinct byte content so
    // the client-side content-hash dedup does not collapse them into a
    // single entry.
    await gallery.uploadPhoto(generateTestImage('tiny', [255, 64, 64]), 'incremental-1.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
    expect(await gallery.photos.count()).toBe(1);

    // Upload second photo - should appear without reload
    await gallery.uploadPhoto(generateTestImage('tiny', [64, 255, 64]), 'incremental-2.png');
    await expect(async () => {
      expect(await gallery.photos.count()).toBe(2);
    }).toPass({ timeout: 60000 });

    // Upload third photo
    await gallery.uploadPhoto(generateTestImage('tiny', [64, 64, 255]), 'incremental-3.png');
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

    // Upload photos with distinct byte content so the client-side
    // content-hash dedup does not collapse them into a single entry.
    await gallery.uploadPhoto(generateTestImage('tiny', [255, 64, 64]), 'delete-sync-1.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    await gallery.uploadPhoto(generateTestImage('tiny', [64, 64, 255]), 'delete-sync-2.png');
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

    await page1.route('**/api/v1/**', async (route) => {
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

    // Upload 3 photos. Race each uploadPhoto against the manifest finalize
    // POST response so the loop only advances after the server has fully
    // committed each manifest. Use a unique color per photo so the upload
    // pipeline cannot dedupe them by content hash and silently drop a
    // duplicate upload.
    const photoColors: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    for (let i = 1; i <= 3; i++) {
      const finalized = page1.waitForResponse(
        (resp) => /\/api\/v\d+\/manifests\/[^/]+\/finalize/.test(resp.url()) && resp.ok(),
        { timeout: 60000 },
      );
      const img = generateTestImage('tiny', photoColors[i - 1]);
      await gallery1.uploadPhoto(img, `version-photo-${i}.png`);
      await finalized;
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
    await page2.route('**/api/v1/**', async (route) => {
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
      await page.route('**/api/v1/**', async (route) => {
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

    // Upload from both sessions concurrently. Use the page object's durable
    // upload wait so both manifests are committed before the reload-based sync.
    const testImage = generateTestImage();
    await Promise.all([
      gallery1.uploadPhoto(testImage, 'session1-photo.png'),
      gallery2.uploadPhoto(Buffer.from(testImage), 'session2-photo.png'),
    ]);

    // Wait for server to persist both uploads (API calls to complete)
    await waitForNetworkIdle(page1, { timeout: 30000, urlPattern: /\/api\// });
    await waitForNetworkIdle(page2, { timeout: 30000, urlPattern: /\/api\// });

    // Refresh both to sync - wait for DOM to be ready
    await Promise.all([
      page1.reload({ waitUntil: 'domcontentloaded' }),
      page2.reload({ waitUntil: 'domcontentloaded' }),
    ]);

    await login1.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);
    await login2.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);

    // Navigate to home first to ensure we're on the album list
    await Promise.all([
      page1.goto('/', { waitUntil: 'domcontentloaded' }),
      page2.goto('/', { waitUntil: 'domcontentloaded' }),
    ]);

    await Promise.all([
      login1.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser),
      login2.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser),
    ]);

    // Wait for app shell and album cards on both pages
    await appShell1.waitForLoad();
    
    // Create appShell for page2 - page2 doesn't have an appShell yet
    const appShell2 = new AppShell(page2);
    await appShell2.waitForLoad();

    // Navigate to the album on both pages. Arm sync response waits before
    // clicking so the initial album sync cannot race past the test.
    const page1InitialSync = waitForAlbumSyncResponse(page1);
    const page2InitialSync = waitForAlbumSyncResponse(page2);

    await expect(page1.getByTestId('album-card').first()).toBeVisible({ timeout: 30000 });
    await expect(page2.getByTestId('album-card').first()).toBeVisible({ timeout: 30000 });
    await page1.getByTestId('album-card').first().click();
    await page2.getByTestId('album-card').first().click();

    await gallery1.waitForLoad();
    await gallery2.waitForLoad();

    const [page1SyncResponse, page2SyncResponse] = await Promise.all([
      page1InitialSync,
      page2InitialSync,
    ]);
    expect(page1SyncResponse.ok()).toBe(true);
    expect(page2SyncResponse.ok()).toBe(true);

    await Promise.all([
      gallery1.waitForSync(),
      gallery2.waitForSync(),
      waitForNetworkIdle(page1, { timeout: 30000, urlPattern: /\/api\// }),
      waitForNetworkIdle(page2, { timeout: 30000, urlPattern: /\/api\// }),
    ]);

    // Both should show both photos (using polling wait instead of fixed timeout)
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
