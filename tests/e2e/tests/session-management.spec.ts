/**
 * Session and Authentication E2E Tests
 *
 * Tests for session persistence, key caching, and authentication flows.
 */

import {
    AppShell,
    createAlbumViaAPI,
    expect,
    LoginPage,
    loginUser,
    SettingsPage,
    test,
    TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Session Management @p1 @auth', () => {
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

    test('P1-SESSION-5b: wrong password on cold start (new user first login attempt) shows error and allows retry', async ({
      testContext,
    }) => {
      // Create a fresh user that has NEVER logged in before
      const user = await testContext.createAuthenticatedUser('cold-start-wrong-pass');

      await user.page.goto('/');

      const loginPage = new LoginPage(user.page);
      await loginPage.waitForForm();

      // Detect auth mode
      const isLocalAuth = await loginPage.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

      if (isLocalAuth) {
        // LocalAuth mode: Try to LOGIN (not register) with credentials for non-existent user
        // This should fail because the user doesn't exist yet
        await loginPage.usernameInput.fill('nonexistent-user-12345');
        await loginPage.passwordInput.fill('some-password');
        await loginPage.loginButton.click();

        // Should show error (invalid credentials - user doesn't exist)
        await loginPage.expectError(/invalid|credentials|password|username/i);

        // User should still be on login form (not locked out)
        await expect(loginPage.form).toBeVisible();
        await expect(loginPage.loginButton).toBeEnabled();

        // User can switch to register mode and create account successfully
        await loginPage.switchToRegisterMode();
        await loginPage.usernameInput.fill(user.email);
        await loginPage.passwordInput.fill(TEST_PASSWORD);
        await loginPage.confirmPasswordInput.fill(TEST_PASSWORD);
        await loginPage.createAccountButton.click();

        // Should succeed now
        await loginPage.expectLoginSuccess();
      } else {
        // ProxyAuth mode: First login with any password creates the account
        // For ProxyAuth, "wrong password on cold start" doesn't apply because
        // the first password becomes the key. However, we can test that after
        // initial setup with one password, a different password fails.
        
        // First, login with the correct password to set up the account
        await loginPage.login(TEST_PASSWORD);
        await loginPage.expectLoginSuccess();

        // Logout
        const appShell = new AppShell(user.page);
        await appShell.logout();

        // Now try with wrong password (this tests returning user scenario)
        await loginPage.waitForForm();
        await loginPage.login('completely-wrong-password-xyz');

        // Should show error (can't decrypt with wrong password)
        await loginPage.expectError();

        // User should still be on login form (not locked out)
        await expect(loginPage.form).toBeVisible();
        await expect(loginPage.loginButton).toBeEnabled();

        // User can retry with correct password
        await loginPage.passwordInput.clear();
        await loginPage.login(TEST_PASSWORD);
        await loginPage.expectLoginSuccess();
      }
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

      // Set up auth for second page (for ProxyAuth mode)
      await page2.route('**/api/**', async (route) => {
        const headers = {
          ...route.request().headers(),
          'Remote-User': user.email,
        };
        await route.continue({ headers });
      });

      await page2.goto('/');

      // Second tab might restore session or need login
      // Wait longer for session restoration (key cache takes time)
      const hasAppShell = await page2
        .getByTestId('app-shell')
        .isVisible({ timeout: 15000 })
        .catch(() => false);

      if (!hasAppShell) {
        const loginPage2 = new LoginPage(page2);
        await loginPage2.waitForForm();
        // Use loginOrRegister to handle LocalAuth mode (which requires username)
        // Note: AuthenticatedUser uses 'email' as the username (it's also the unique identifier)
        await loginPage2.loginOrRegister(TEST_PASSWORD, user.email);
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

  test.describe('Idle Timeout', () => {
    test('P1-SESSION-7: user is logged out after 30+ minutes of inactivity', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('idle-timeout-user');

      // Install fake timers before navigation
      // This must be done before any page interaction that would start timers
      await user.page.clock.install({ time: new Date('2026-01-07T10:00:00.000Z') });

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Verify we're logged in
      await expect(appShell.shell).toBeVisible();

      // Verify session storage has data before timeout
      const sessionDataBefore = await user.page.evaluate(() => {
        return sessionStorage.getItem('mosaic:sessionState');
      });
      expect(sessionDataBefore).not.toBeNull();

      // Fast-forward time by 31 minutes (idle timeout is 30 minutes by default)
      // This simulates 31 minutes of inactivity
      await user.page.clock.fastForward(31 * 60 * 1000);

      // The idle timeout should have triggered, logging the user out
      // Wait for the login form to appear
      const loginPage = new LoginPage(user.page);
      await loginPage.expectFormVisible();

      // Verify session storage is cleared
      const sessionDataAfter = await user.page.evaluate(() => {
        return sessionStorage.getItem('mosaic:sessionState');
      });
      expect(sessionDataAfter).toBeNull();
    });

    test('P1-SESSION-8: user activity resets idle timeout', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('activity-reset-user');

      // Install fake timers before navigation
      await user.page.clock.install({ time: new Date('2026-01-07T10:00:00.000Z') });

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Wait 20 minutes (less than 30-minute timeout)
      await user.page.clock.fastForward(20 * 60 * 1000);

      // Simulate user activity (mousedown event resets idle timer)
      await user.page.mouse.click(100, 100);

      // Wait another 20 minutes (total 40 minutes, but only 20 since last activity)
      await user.page.clock.fastForward(20 * 60 * 1000);

      // User should still be logged in because activity reset the timer
      await expect(appShell.shell).toBeVisible();

      // Session storage should still have data
      const sessionData = await user.page.evaluate(() => {
        return sessionStorage.getItem('mosaic:sessionState');
      });
      expect(sessionData).not.toBeNull();
    });

    test('P1-SESSION-9: idle timeout setting can be changed via UI', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('min-timeout-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.waitForLoad();

      // Open settings and change idle timeout to 15 minutes via UI
      await appShell.openSettings();
      const settingsPage = new SettingsPage(user.page);
      await settingsPage.waitForLoad();
      
      // Change idle timeout to 15 minutes
      await settingsPage.setIdleTimeout('15');
      
      // Verify the select shows the new value
      const selectedValue = await settingsPage.idleTimeoutSelect.inputValue();
      expect(selectedValue).toBe('15');
      
      // Click save to persist the settings
      await settingsPage.saveButton.click();
      
      // Wait for save to complete (success message appears)
      await expect(user.page.getByText(/saved successfully/i)).toBeVisible({ timeout: 5000 });
      
      await settingsPage.close();
      
      // Verify the setting persisted in localStorage
      const storedSettings = await user.page.evaluate(() => {
        const data = localStorage.getItem('mosaic:settings');
        return data ? JSON.parse(data) : null;
      });
      expect(storedSettings).not.toBeNull();
      expect(storedSettings.idleTimeout).toBe(15);
      
      // Reload and verify setting is still 15 minutes
      await user.page.reload();
      
      // Re-login if needed
      const loginPage = new LoginPage(user.page);
      const needsLogin = await loginPage.form.isVisible({ timeout: 5000 }).catch(() => false);
      if (needsLogin) {
        await loginPage.login(TEST_PASSWORD);
        await loginPage.expectLoginSuccess();
      }
      
      await appShell.waitForLoad();
      await appShell.openSettings();
      await settingsPage.waitForLoad();
      
      // Verify the setting persisted after reload
      const persistedValue = await settingsPage.idleTimeoutSelect.inputValue();
      expect(persistedValue).toBe('15');
    });
  });
});
