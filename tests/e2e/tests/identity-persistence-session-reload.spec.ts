/**
 * Identity Persistence: Reload-without-relogin E2E (v1.0.x bundle-seal-222 follow-up).
 *
 * Regression coverage for the cookie-only `session.restoreSession()` path: when
 * the user reloads the page (session cookie still valid, password re-entered to
 * unlock the worker), the worker must re-thread the `wrappedIdentitySeed`
 * returned by `GET /api/v1/me`. Without this thread, the worker mints a fresh
 * random Ed25519/X25519 identity and every previously-sealed epoch bundle
 * fails to open with rust code 222 (BundleSealOpenFailed).
 *
 * This spec is intentionally narrower than the broader P0-IDENTITY-1 test: it
 * pins the *reload-only* path that depends on `/me` exposing
 * `wrappedIdentitySeed`.
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

async function firstTimeLogin(
  page: Page,
  loginPage: LoginPage,
  username: string,
  password: string,
): Promise<void> {
  await loginPage.waitForForm();
  const usernameInput = page.getByLabel(/username|uživatelské jméno/i);
  const isLocalAuth = await usernameInput
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (isLocalAuth) {
    await loginPage.register(username, password);
  } else {
    await loginPage.login(password, username);
  }
}

test.describe('Identity Persistence: Reload via /me wrappedIdentitySeed @p1 @auth @crypto @slow', () => {
  test.slow();

  test('restoreSession() preserves identity so sealed epoch bundles open after reload (code 222 regression)', async ({
    browser,
    testUser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const logCollector = new LogCollector(page);

    // Inject Remote-User for ProxyAuth deployments; harmless for LocalAuth.
    await page.route('**/api/v1/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    try {
      await page.goto('/');

      const loginPage = new LoginPage(page);
      await firstTimeLogin(page, loginPage, testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();

      await appShell.createAlbum();
      const createDialog = new CreateAlbumDialogPage(page);
      await createDialog.createAlbum(`Reload Identity Album ${Date.now()}`);

      const albumCard = page.getByTestId('album-card').first();
      await expect(albumCard).toBeVisible({
        timeout: NETWORK_TIMEOUT.NAVIGATION,
      });
      await albumCard.click();

      const gallery = new GalleryPage(page);
      await gallery.waitForLoad();

      const testImage = generateTestImage();
      await gallery.uploadPhoto(testImage, 'reload-identity-photo.png');
      await expect(gallery.photos.first()).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });
      const photoCountBefore = await gallery.photos.count();
      expect(photoCountBefore).toBeGreaterThanOrEqual(1);

      await waitForNetworkIdle(page, {
        timeout: NETWORK_TIMEOUT.NAVIGATION,
        urlPattern: /\/api\//,
      });

      // Collect console errors AFTER initial setup, before reload, so we
      // capture only reload-path errors (code 222 BundleSealOpenFailed
      // surfaces as a console error from the crypto worker).
      const reloadErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') reloadErrors.push(msg.text());
      });

      // Hard reload — session cookie persists, OPFS persists, but the
      // crypto worker is fresh and must re-derive identity from the
      // wrappedIdentitySeed surfaced by GET /api/v1/me.
      await page.reload({ waitUntil: 'domcontentloaded' });

      await loginPage.unlockAfterReload(TEST_CONSTANTS.PASSWORD, testUser);
      await appShell.waitForLoad();

      await page
        .waitForLoadState('networkidle', { timeout: 30000 })
        .catch(() => {});

      const galleryVisible = await gallery.gallery
        .isVisible()
        .catch(() => false);
      if (!galleryVisible) {
        const card = page.getByTestId('album-card').first();
        await expect(card).toBeVisible({ timeout: 30000 });
        await card.click();
      }

      await gallery.waitForLoad();

      // The critical assertion: the previously-uploaded photo must still
      // decrypt and render. If the identity was re-minted (code 222),
      // the epoch bundle fails to open and the photo stays hidden.
      await expect(gallery.photos.first()).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });
      const photoCountAfter = await gallery.photos.count();
      expect(photoCountAfter).toBe(photoCountBefore);

      // No code-222 errors should have surfaced after reload.
      const codeTwoTwoTwo = reloadErrors.filter((line) =>
        /code\s*222|BundleSealOpenFailed|bundle.*seal.*open/i.test(line),
      );
      expect(codeTwoTwoTwo, codeTwoTwoTwo.join('\n')).toEqual([]);
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
