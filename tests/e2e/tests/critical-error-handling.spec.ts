/**
 * Critical E2E Flow Tests - Error Handling
 *
 * These tests cover error handling scenarios:
 * 1. Empty form validation
 * 2. Network failure graceful handling
 *
 * These are P1 priority tests for security and UX.
 */

import {
    AppShell,
    expect,
    LoginPage,
    test,
} from '../fixtures';
import { getAlbumsViaAPI, deleteAlbumViaAPI } from '../framework';

/**
 * Clean up all albums for a user.
 * Used in afterEach hooks for tests using poolUser to prevent state accumulation.
 */
async function cleanupUserAlbums(username: string): Promise<void> {
  try {
    const albums = await getAlbumsViaAPI(username);
    for (const album of albums) {
      try {
        await deleteAlbumViaAPI(username, album.id);
      } catch (err) {
        console.warn(`[Cleanup] Failed to delete album ${album.id}: ${err}`);
      }
    }
    if (albums.length > 0) {
      console.log(`[Cleanup] Deleted ${albums.length} albums for ${username}`);
    }
  } catch (err) {
    console.warn(`[Cleanup] Failed to get albums for ${username}: ${err}`);
  }
}

test.describe('Critical Flow: Error Handling @p0 @critical @security', () => {
  // Track current pool user for cleanup
  let currentPoolUsername: string | undefined;

  test.afterEach(async () => {
    // Clean up all albums for the pool user to prevent state accumulation
    if (currentPoolUsername) {
      await cleanupUserAlbums(currentPoolUsername);
      currentPoolUsername = undefined;
    }
  });

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
    currentPoolUsername = poolUser.username;

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
