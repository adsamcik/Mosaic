/**
 * Smoke Test Suite - Fast Validation
 *
 * This suite runs the most critical happy paths as quickly as possible.
 * Designed for quick validation during development - NOT comprehensive testing.
 *
 * Target: Complete in under 60 seconds
 * Coverage: Registration → Login → Album CRUD → Photo Upload
 *
 * Run with: npx playwright test --project=smoke
 * Or: API_URL=http://localhost:5000 npx playwright test smoke.spec.ts --project=chromium
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

// Use serial mode to share state between tests and reduce setup overhead
test.describe.configure({ mode: 'serial' });

/**
 * Helper to perform login based on auth mode
 */
async function performLogin(
  page: import('@playwright/test').Page,
  username: string,
  password: string
) {
  const loginPage = new LoginPage(page);
  await loginPage.waitForForm();

  // Detect auth mode by checking for username field
  const usernameInput = page.getByLabel('Username');
  const isLocalAuth = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

  if (isLocalAuth) {
    await loginPage.login(password, username);
  } else {
    // ProxyAuth mode: just enter password
    await loginPage.passwordInput.fill(password);
    await page.getByRole('button', { name: /unlock|sign in/i }).click();
  }

  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });
  return isLocalAuth;
}

/**
 * Helper to perform registration based on auth mode
 */
async function performRegistration(
  page: import('@playwright/test').Page,
  username: string,
  password: string
) {
  const loginPage = new LoginPage(page);
  await loginPage.waitForForm();

  // Detect auth mode by checking for username field
  const usernameInput = page.getByLabel('Username');
  const isLocalAuth = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

  if (isLocalAuth) {
    // LocalAuth mode: register new user with username/password
    await loginPage.register(username, password);
  } else {
    // ProxyAuth mode: just enter password to initialize crypto
    await loginPage.passwordInput.fill(password);
    await page.getByRole('button', { name: /unlock|sign in/i }).click();
  }

  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });
  return isLocalAuth;
}

/**
 * Helper to set up page with auth header injection
 */
async function setupPage(page: import('@playwright/test').Page, username: string) {
  await page.route('**/api/**', async (route) => {
    const headers = {
      ...route.request().headers(),
      'Remote-User': username,
    };
    await route.continue({ headers });
  });
}

test.describe('Smoke Tests @smoke @p0 @fast', () => {
  // Shared state across tests
  let testUsername: string;
  const albumName = 'Smoke Test Album';

  test.beforeAll(() => {
    // Generate unique username for this test run
    testUsername = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  });

  test('SMOKE-1: can register/initialize a new user', async ({ page }) => {
    await setupPage(page, testUsername);
    await page.goto('/');
    await performRegistration(page, testUsername, TEST_CONSTANTS.PASSWORD);

    // Verify app shell has critical elements
    const appShell = new AppShell(page);
    await expect(appShell.albumList).toBeVisible();
  });

  test('SMOKE-2: can login with existing credentials', async ({ page }) => {
    await setupPage(page, testUsername);
    await page.goto('/');
    await performLogin(page, testUsername, TEST_CONSTANTS.PASSWORD);

    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    await expect(appShell.albumList).toBeVisible();
  });

  test('SMOKE-3: can create an album', async ({ page }) => {
    await setupPage(page, testUsername);
    await page.goto('/');
    await performLogin(page, testUsername, TEST_CONSTANTS.PASSWORD);

    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Create album via UI
    await appShell.createAlbum();

    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(albumName);

    // Verify album card appears
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await expect(albumCard).toContainText(albumName);
  });

  test('SMOKE-4: can upload a photo to album', async ({ page }) => {
    await setupPage(page, testUsername);
    await page.goto('/');
    await performLogin(page, testUsername, TEST_CONSTANTS.PASSWORD);

    // Navigate to the album
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

  test('SMOKE-5: can view uploaded photo in gallery', async ({ page }) => {
    await setupPage(page, testUsername);
    await page.goto('/');
    await performLogin(page, testUsername, TEST_CONSTANTS.PASSWORD);

    // Navigate to the album
    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    // Verify gallery shows photo
    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Photo should still be there from previous test
    const photoCount = await gallery.photos.count();
    expect(photoCount).toBeGreaterThanOrEqual(1);
  });

  test('SMOKE-6: can logout and session is cleared', async ({ page }) => {
    await setupPage(page, testUsername);
    await page.goto('/');
    await performLogin(page, testUsername, TEST_CONSTANTS.PASSWORD);

    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Logout
    await appShell.logout();

    // Should be back at login
    const loginPage = new LoginPage(page);
    await loginPage.expectLoginFormVisible();
  });
});
