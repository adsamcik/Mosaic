/**
 * Smoke Test Suite - Fast Validation
 *
 * This suite runs the most critical happy paths as quickly as possible.
 * Designed for quick validation during development - NOT comprehensive testing.
 *
 * Target: Complete in under 90 seconds
 * Coverage: Registration/Login → Album CRUD → Photo Upload → Logout
 *
 * Run with: npx playwright test --project=smoke
 * Or: API_URL=http://localhost:5000 npx playwright test smoke.spec.ts --project=chromium
 *
 * These tests use a SINGLE browser context to maintain session across all tests,
 * making them fast and self-contained.
 */

import {
  AppShell,
  CreateAlbumDialogPage,
  expect,
  GalleryPage,
  generateTestImage,
  LoginPage,
  test as base,
  TEST_CONSTANTS,
} from '../fixtures';
import { BrowserContext, Page } from '@playwright/test';

// Extend the base test to provide a shared context across all smoke tests
const test = base.extend<{
  sharedContext: { context: BrowserContext; page: Page; username: string };
}>({
  sharedContext: [async ({ browser }, use) => {
    const username = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Set up auth header injection
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': username,
      };
      await route.continue({ headers });
    });
    
    await use({ context, page, username });
    
    await context.close();
  }, { scope: 'worker' }],
});

// Use serial mode - tests share state
test.describe.configure({ mode: 'serial' });

test.describe('Smoke Tests @smoke @p0 @fast', () => {
  const albumName = 'Smoke Test Album';

  test('SMOKE-1: can register and initialize crypto', async ({ sharedContext }) => {
    const { page, username } = sharedContext;
    await page.goto('/');

    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();

    // Detect auth mode by checking for username field
    const usernameInput = page.getByLabel('Username');
    const isLocalAuth = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

    if (isLocalAuth) {
      // LocalAuth mode: register new user
      await loginPage.register(username, TEST_CONSTANTS.PASSWORD);
    } else {
      // ProxyAuth mode: just enter password to initialize crypto
      await loginPage.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
      await page.getByRole('button', { name: /unlock|sign in/i }).click();
    }

    // Verify app shell loads (crypto initialized successfully)
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });

    // Verify app shell has critical elements
    const appShell = new AppShell(page);
    await expect(appShell.albumList).toBeVisible();
  });

  test('SMOKE-2: can create an album', async ({ sharedContext }) => {
    const { page } = sharedContext;

    // We're already logged in from SMOKE-1 (same context)
    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Create album via UI
    await appShell.createAlbum();

    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.waitForDialog();
    await createDialog.fillName(albumName);
    await createDialog.submit();

    // Wait for dialog to close (success) or show error
    await expect(async () => {
      const isDialogHidden = await createDialog.dialog.isHidden();
      const hasError = await page.getByTestId('create-album-error').isVisible().catch(() => false);

      if (hasError) {
        const errorText = await page.getByTestId('create-album-error').textContent();
        throw new Error(`Album creation failed with error: ${errorText}`);
      }

      expect(isDialogHidden).toBe(true);
    }).toPass({ timeout: 30000 });

    // Verify album card appears
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await expect(albumCard).toContainText(albumName);
  });

  test('SMOKE-3: can upload a photo to album', async ({ sharedContext }) => {
    const { page } = sharedContext;

    // Navigate to the album (we're still logged in)
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    // Wait for gallery to load
    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Upload a photo
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'smoke-test-photo.png');

    // Verify photo appears
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });
  });

  test('SMOKE-4: can view photo persists in gallery', async ({ sharedContext }) => {
    const { page } = sharedContext;

    // Verify gallery shows photo (we're already in the gallery from SMOKE-3)
    const gallery = new GalleryPage(page);

    // Photo should still be there
    const photoCount = await gallery.photos.count();
    expect(photoCount).toBeGreaterThanOrEqual(1);
  });

  test('SMOKE-5: can navigate back to album list', async ({ sharedContext }) => {
    const { page } = sharedContext;

    // Click back to albums
    const appShell = new AppShell(page);
    await appShell.backToAlbumsButton.click();

    // Verify we're back at the album list
    await expect(appShell.albumList).toBeVisible({ timeout: 30000 });
    
    // Verify album card is still there
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible();
  });

  test('SMOKE-6: can logout and session is cleared', async ({ sharedContext }) => {
    const { page } = sharedContext;

    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Logout
    await appShell.logout();

    // Should be back at login
    const loginPage = new LoginPage(page);
    await loginPage.expectLoginFormVisible();
  });
});
