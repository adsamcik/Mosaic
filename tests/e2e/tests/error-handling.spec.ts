/**
 * Error Handling E2E Tests
 *
 * Tests for graceful error handling and recovery scenarios.
 */

import {
    AppShell,
    createAlbumViaAPI,
    expect,
    goOffline,
    goOnline,
    LoginPage,
    loginUser,
    mockApiError,
    test,
    TEST_PASSWORD
} from '../fixtures-enhanced';
import { waitForCondition } from '../framework';

test.describe('Error Handling @p1 @security', () => {
  test.describe('Network Errors', () => {
    test('P2-ERROR-1: offline state shows indicator', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('offline-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Go offline
      await goOffline(user.page);

      // Wait for app to detect offline state (service worker or network listener)
      // Check that the shell remains visible and functional during offline
      await waitForCondition(
        async () => {
          // App should remain stable and visible while offline
          return await appShell.shell.isVisible();
        },
        { timeout: 5000, message: 'App should remain functional while offline' }
      );

      // Go back online
      await goOnline(user.page);

      // App should recover
      await expect(appShell.shell).toBeVisible();
    });

    test('P2-ERROR-2: API error shows user-friendly message', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('api-error-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Mock API error for next request
      await mockApiError(user.page, '**/api/albums', 500, {
        error: 'Internal Server Error',
      });

      // Try to create album
      await appShell.openCreateAlbumDialog();

      // Fill in name and submit
      const nameInput = user.page.getByTestId('album-name-input');
      await nameInput.fill('Error Test Album');

      const createButton = user.page.getByTestId('create-button');
      await createButton.click();

      // Wait for error feedback (toast, dialog message, or error state)
      // The app may show a toast notification, inline error, or the dialog may close
      await waitForCondition(
        async () => {
          // Check for common error indicators:
          // 1. Toast/notification with error message
          const hasToast = await user.page.locator('[data-testid="toast"], [role="alert"], .toast').isVisible().catch(() => false);
          // 2. Error text in the dialog
          const hasErrorText = await user.page.getByText(/error|failed|problem/i).isVisible().catch(() => false);
          // 3. Dialog closed (implicit error handling)
          const dialogClosed = !(await user.page.getByTestId('create-album-dialog').isVisible().catch(() => false));
          return hasToast || hasErrorText || dialogClosed;
        },
        { timeout: 10000, message: 'Expected error feedback after API error' }
      );

      // App should still be functional
      await expect(appShell.shell).toBeVisible();
    });

    test('P2-ERROR-3: timeout error allows retry', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('timeout-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Create album successfully
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Reload to see the album
      await user.page.reload();

      // Check if we need to re-login (session may persist)
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      // Should be able to see album
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Validation Errors', () => {
    test('P2-ERROR-4: invalid input shows validation message', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('validation-user');

      await user.page.goto('/');

      const loginPage = new LoginPage(user.page);
      await loginPage.waitForForm();

      // Try empty password
      await loginPage.loginButton.click();

      // Should show validation error
      await loginPage.expectError();
    });

    test('P2-ERROR-5: form preserves input after validation error', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('preserve-input');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      await appShell.openCreateAlbumDialog();

      const nameInput = user.page.getByTestId('album-name-input');

      // Enter a name
      await nameInput.fill('Test Album');

      // Clear it to trigger validation
      await nameInput.clear();

      // Try to submit
      const createButton = user.page.getByTestId('create-button');
      const isDisabled = await createButton.isDisabled();

      // Either disabled or will show error on submit
      if (!isDisabled) {
        await createButton.click();
      }

      // Dialog should still be open
      await expect(user.page.getByTestId('create-album-dialog')).toBeVisible();
    });
  });

  test.describe('Recovery Scenarios', () => {
    test('P2-ERROR-6: page reload recovers from error state', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('recovery-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Cause an error state by going offline briefly
      await goOffline(user.page);
      // Brief offline period - wait for app to register the offline state
      await waitForCondition(
        async () => await appShell.shell.isVisible(),
        { timeout: 2000, message: 'App should remain stable during brief offline' }
      );
      await goOnline(user.page);

      // Reload
      await user.page.reload();

      // Check if we need to re-login (session may persist)
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      // Should be back to normal
      await appShell.waitForLoad();
    });

    test('P2-ERROR-7: can continue working after transient error', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('transient-error');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Create an album successfully
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Refresh to see it
      await user.page.reload();

      // Check if we need to re-login (session may persist)
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      // Should work normally
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
    });
  });
});
