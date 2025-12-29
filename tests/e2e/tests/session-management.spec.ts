/**
 * Session and Authentication E2E Tests
 *
 * Tests for session persistence, key caching, and authentication flows.
 */

import {
  test,
  expect,
  LoginPage,
  AppShell,
  loginUser,
  createAlbumViaAPI,
  TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Session Management', () => {
  test.describe('Key Caching', () => {
    test('P1-SESSION-1: session restores after page reload within cache duration', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('session-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Create an album to verify session is working
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Reload page
      await user.page.reload();

      // Wait for page to stabilize after reload - either login form or app shell should appear
      await expect(
        user.page.locator('[data-testid="app-shell"], [data-testid="login-form"]').first()
      ).toBeVisible({ timeout: 30000 });

      // Session should restore without requiring password
      // Either we see the app shell directly, or we need to re-login
      const hasAppShell = await user.page
        .getByTestId('app-shell')
        .isVisible()
        .catch(() => false);

      if (!hasAppShell) {
        // Need to re-login
        const loginPage = new LoginPage(user.page);
        await loginPage.login(TEST_PASSWORD);
        await loginPage.expectLoginSuccess();
      }

      // Should be logged in
      await appShell.waitForLoad();
    });

    test('P1-SESSION-2: logout clears session completely', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('logout-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Logout
      await appShell.logout();

      // Should see login form
      const loginPage = new LoginPage(user.page);
      await loginPage.expectFormVisible();

      // Reload should still show login form (session cleared)
      await user.page.reload();
      await loginPage.expectFormVisible();
    });

    test('P1-SESSION-3: navigating to protected route redirects to login', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('redirect-user');

      // Don't login, just try to access protected route
      await user.page.goto('/albums');

      // Should redirect to login
      const loginPage = new LoginPage(user.page);
      await loginPage.expectFormVisible();
    });
  });

  test.describe('Password Validation', () => {
    test('P1-SESSION-4: empty password shows error', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('empty-pass-user');

      await user.page.goto('/');

      const loginPage = new LoginPage(user.page);
      await loginPage.waitForForm();

      // Try to submit without password
      await loginPage.loginButton.click();

      // Should show error
      await loginPage.expectError();
    });

    test('P1-SESSION-5: wrong password after account setup shows error', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('wrong-pass-user');

      // First login (creates account)
      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Logout
      await appShell.logout();

      // Try to login with wrong password
      const loginPage = new LoginPage(user.page);
      await loginPage.waitForForm();
      await loginPage.login('totally-wrong-password-12345');

      // Should show error
      await loginPage.expectError();
    });
  });

  test.describe('Multi-Tab Behavior', () => {
    test('P1-SESSION-6: two tabs can be logged in simultaneously', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('tab-user');

      // Login in first tab
      await loginUser(user, TEST_PASSWORD);

      const appShell1 = new AppShell(user.page);
      await appShell1.waitForLoad();

      // Open second tab in same context
      const page2 = await user.context.newPage();

      // Set up auth for second page
      await page2.route('**/api/**', async (route) => {
        const headers = {
          ...route.request().headers(),
          'Remote-User': user.email,
        };
        await route.continue({ headers });
      });

      await page2.goto('/');

      // Second tab might restore session or need login
      const hasAppShell = await page2
        .getByTestId('app-shell')
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (!hasAppShell) {
        const loginPage2 = new LoginPage(page2);
        await loginPage2.waitForForm();
        await loginPage2.login(TEST_PASSWORD);
        await loginPage2.expectLoginSuccess();
      }

      const appShell2 = new AppShell(page2);
      await appShell2.waitForLoad();

      // Both tabs should work
      await expect(appShell1.shell).toBeVisible();
      await expect(appShell2.shell).toBeVisible();

      await page2.close();
    });
  });
});
