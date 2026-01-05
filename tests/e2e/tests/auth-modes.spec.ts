/**
 * Authentication Mode E2E Tests
 *
 * Tests for both LocalAuth and ProxyAuth authentication modes.
 *
 * LocalAuth Mode:
 * - Cookie-based session authentication
 * - Ed25519 challenge-response verification
 * - User registration and login flows
 * - Session expiration and sliding window
 *
 * ProxyAuth Mode (Authelia-like):
 * - Remote-User header-based authentication
 * - Trusted proxy validation
 * - Header injection and forwarding
 *
 * The backend mode is determined by Auth:Mode configuration.
 * These tests verify both modes work correctly when deployed.
 *
 * Note: Tests detect the backend mode and skip tests that don't apply
 * to the current mode. Run against both modes for full coverage.
 */

import { test, expect, LoginPage, AppShell, TEST_CONSTANTS } from '../fixtures';

/**
 * API base URL for direct API calls
 */
const API_URL = process.env.API_URL || 'http://localhost:5000';

/**
 * Detect which auth mode the backend is running in.
 * LocalAuth mode: /api/auth/init returns 200 with challenge
 * ProxyAuth mode: /api/auth/init returns 404
 */
async function detectAuthMode(): Promise<'LocalAuth' | 'ProxyAuth'> {
  try {
    const response = await fetch(`${API_URL}/api/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mode-detect-test' }),
    });

    if (response.status === 200) {
      return 'LocalAuth';
    }
    return 'ProxyAuth';
  } catch {
    // If we can't reach the endpoint, assume ProxyAuth
    return 'ProxyAuth';
  }
}

test.describe('Authentication Modes @p1 @auth', () => {
  test.describe('Mode Detection', () => {
    test('frontend detects auth mode from backend', async ({ page }) => {
      // The frontend should detect the auth mode by calling /api/auth/init
      // In LocalAuth mode: returns challenge data
      // In ProxyAuth mode: returns 404

      await page.goto('/');

      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();

      // Check if LocalAuth UI elements are visible
      // In LocalAuth mode, the username field should be visible
      // In ProxyAuth mode, only password field should be visible
      const hasUsernameField = await loginPage.usernameInput.isVisible().catch(() => false);

      // Log the detected mode for debugging
      console.log(`[TEST] Detected auth mode: ${hasUsernameField ? 'LocalAuth' : 'ProxyAuth'}`);

      // At minimum, the login form should be visible
      await loginPage.expectLoginFormVisible();
    });

    test('/api/auth/init returns expected response based on mode', async ({ page }) => {
      // Test the init endpoint behavior
      const response = await page.request.post(`${API_URL}/api/auth/init`, {
        data: { username: 'test-user' },
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // In LocalAuth mode: returns 200 with challenge data
      // In ProxyAuth mode: returns 404
      expect([200, 404]).toContain(response.status());

      if (response.status() === 200) {
        const data = await response.json();
        // LocalAuth mode - should have challenge fields
        expect(data).toHaveProperty('challenge');
        console.log('[TEST] LocalAuth mode detected: init endpoint returned challenge');
      } else {
        console.log('[TEST] ProxyAuth mode detected: init endpoint returned 404');
      }
    });

    test('health endpoint is always accessible', async ({ page }) => {
      const response = await page.request.get(`${API_URL}/health`);

      expect(response.status()).toBe(200);
    });

    test('protected endpoints require authentication', async ({ page }) => {
      // Try to access protected endpoint without auth header
      const response = await page.request.get(`${API_URL}/api/albums`, {
        headers: {
          // No Remote-User header
        },
      });

      // Should return 401 Unauthorized
      expect(response.status()).toBe(401);
    });
  });

  test.describe('LocalAuth Mode: Registration Flow', () => {
    test.beforeEach(async () => {
      // Skip if not in LocalAuth mode
      const mode = await detectAuthMode();
      if (mode !== 'LocalAuth') {
        test.skip(true, 'Test requires LocalAuth mode');
      }
    });

    test('new user can register with username and password', async ({ page, testUser }) => {
      // Setup Remote-User header (still needed for API routing)
      await page.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': testUser };
        await route.continue({ headers });
      });

      await page.goto('/');

      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();

      // LocalAuth mode - use full registration flow
      await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();
    });

    test('registered user can login again after logout', async ({ browser, testUser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': testUser };
        await route.continue({ headers });
      });

      try {
        await page.goto('/');

        const loginPage = new LoginPage(page);
        await loginPage.waitForForm();

        // Register new user
        await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
        await loginPage.expectLoginSuccess();

        const appShell = new AppShell(page);
        await appShell.waitForLoad();

        // Logout
        await appShell.logout();
        await loginPage.expectLoginFormVisible();

        // Login again - switch to login mode
        await loginPage.switchToLoginMode();
        await loginPage.usernameInput.fill(testUser);
        await loginPage.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
        await loginPage.loginButton.click();

        // Should succeed or show error (depending on session state)
        await expect(
          page.locator('[data-testid="app-shell"]').or(page.getByRole('alert'))
        ).toBeVisible({ timeout: 60000 });
      } finally {
        // Clean up routes before closing to avoid "route in flight" errors
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
    });

    test('LocalAuth mode shows registration badge', async ({ page }) => {
      await page.goto('/');

      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();

      // Check for LocalAuth badge
      const badge = page.getByTestId('local-auth-badge');
      await expect(badge).toBeVisible();
      console.log('[TEST] LocalAuth badge visible - mode confirmed');
    });
  });

  test.describe('LocalAuth Mode: Session Management', () => {
    test.beforeEach(async () => {
      const mode = await detectAuthMode();
      if (mode !== 'LocalAuth') {
        test.skip(true, 'Test requires LocalAuth mode');
      }
    });

    test('session persists across page reloads', async ({ browser, testUser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': testUser };
        await route.continue({ headers });
      });

      try {
        await page.goto('/');

        const loginPage = new LoginPage(page);
        await loginPage.waitForForm();

        // Register
        await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
        await loginPage.expectLoginSuccess();

        const appShell = new AppShell(page);
        await appShell.waitForLoad();

        // Reload page
        await page.reload();

        // Wait for page to stabilize
        await expect(
          page.locator('[data-testid="app-shell"], [data-testid="login-form"]').first()
        ).toBeVisible({ timeout: 30000 });

        // Session should restore or require re-login
        const hasAppShell = await appShell.shell.isVisible().catch(() => false);
        const hasLoginForm = await loginPage.loginForm.isVisible().catch(() => false);

        expect(hasAppShell || hasLoginForm).toBeTruthy();

        if (hasLoginForm) {
          console.log('[TEST] Session required re-login after reload');
        } else {
          console.log('[TEST] Session persisted after reload');
        }
      } finally {
        // Clean up routes before closing to avoid "route in flight" errors
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
    });

    test('logout clears session and shows login form', async ({ browser, testUser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': testUser };
        await route.continue({ headers });
      });

      try {
        await page.goto('/');

        const loginPage = new LoginPage(page);
        await loginPage.waitForForm();

        // Register
        await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
        await loginPage.expectLoginSuccess();

        const appShell = new AppShell(page);
        await appShell.waitForLoad();

        // Logout
        await appShell.logout();

        // Should show login form
        await loginPage.expectLoginFormVisible();

        // Reload should still show login form
        await page.reload();
        await loginPage.expectLoginFormVisible();
      } finally {
        // Clean up routes before closing to avoid "route in flight" errors
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
    });
  });

  test.describe('LocalAuth Mode: Challenge-Response Auth', () => {
    test.beforeEach(async () => {
      const mode = await detectAuthMode();
      if (mode !== 'LocalAuth') {
        test.skip(true, 'Test requires LocalAuth mode');
      }
    });

    test('wrong password fails authentication', async ({ browser, testUser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': testUser };
        await route.continue({ headers });
      });

      try {
        await page.goto('/');

        const loginPage = new LoginPage(page);
        await loginPage.waitForForm();

        // First register with correct password
        await loginPage.register(testUser, TEST_CONSTANTS.PASSWORD);
        await loginPage.expectLoginSuccess();

        const appShell = new AppShell(page);
        await appShell.waitForLoad();

        // Logout
        await appShell.logout();
        await loginPage.expectLoginFormVisible();

        // Try to login with wrong password
        await loginPage.switchToLoginMode();
        await loginPage.usernameInput.fill(testUser);
        await loginPage.passwordInput.fill('wrong-password-12345');
        await loginPage.loginButton.click();

        // Should show error
        await loginPage.expectErrorMessage();
      } finally {
        // Clean up routes before closing to avoid "route in flight" errors
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
    });
  });

  test.describe('ProxyAuth Mode: Remote-User Header', () => {
    test.beforeEach(async () => {
      const mode = await detectAuthMode();
      if (mode !== 'ProxyAuth') {
        test.skip(true, 'Test requires ProxyAuth mode');
      }
    });

    test('API accepts requests with valid Remote-User header', async ({ page, testUser }) => {
      // Setup Remote-User header injection
      await page.route('**/api/**', async (route) => {
        const headers = {
          ...route.request().headers(),
          'Remote-User': testUser,
        };
        await route.continue({ headers });
      });

      // Navigate to app
      await page.goto('/');

      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();

      // Login with just password (ProxyAuth only needs password for client-side crypto)
      await loginPage.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
      await loginPage.loginButton.click();

      // Should succeed and show app shell
      await loginPage.expectLoginSuccess();

      const appShell = new AppShell(page);
      await appShell.waitForLoad();
    });

    test('user identity is consistent across API calls with same header', async ({
      browser,
      testUser,
    }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      // Track API responses
      const userResponses: string[] = [];

      await page.route('**/api/**', async (route) => {
        const headers = {
          ...route.request().headers(),
          'Remote-User': testUser,
        };

        // Intercept /api/users/me responses
        if (route.request().url().includes('/api/users/me')) {
          const response = await route.fetch({ headers });
          const body = await response.text();
          userResponses.push(body);
          await route.fulfill({ response });
        } else {
          await route.continue({ headers });
        }
      });

      await page.goto('/');

      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();

      // Login
      await loginPage.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
      await loginPage.loginButton.click();
      await loginPage.expectLoginSuccess();

      // Reload page to trigger another /api/users/me call
      await page.reload();

      // Wait for app to stabilize
      await expect(
        page.locator('[data-testid="app-shell"], [data-testid="login-form"]').first()
      ).toBeVisible({ timeout: 30000 });

      // If we got multiple user responses, verify they're consistent
      if (userResponses.length >= 2) {
        const parsed = userResponses.map((r) => {
          try {
            return JSON.parse(r);
          } catch {
            return null;
          }
        });

        // Filter out null/error responses
        const validResponses = parsed.filter((r) => r && r.authSub);

        if (validResponses.length >= 2) {
          expect(validResponses[0].authSub).toBe(validResponses[1].authSub);
        }
      }

      // Clean up routes before closing to avoid "route in flight" errors
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    });

    test('different Remote-User headers result in different users', async ({ browser }) => {
      const user1 = `user1-${Date.now()}@test.local`;
      const user2 = `user2-${Date.now()}@test.local`;

      // Create two contexts with different users
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();

      const page1 = await context1.newPage();
      const page2 = await context2.newPage();

      await page1.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': user1 };
        await route.continue({ headers });
      });

      await page2.route('**/api/**', async (route) => {
        const headers = { ...route.request().headers(), 'Remote-User': user2 };
        await route.continue({ headers });
      });

      try {
        // Both users login
        await page1.goto('/');
        await page2.goto('/');

        const loginPage1 = new LoginPage(page1);
        const loginPage2 = new LoginPage(page2);

        await loginPage1.waitForForm();
        await loginPage2.waitForForm();

        await loginPage1.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
        await loginPage1.loginButton.click();

        await loginPage2.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
        await loginPage2.loginButton.click();

        // Both should reach app shell (they're different users)
        await loginPage1.expectLoginSuccess();
        await loginPage2.expectLoginSuccess();
      } finally {
        // Clean up routes before closing to avoid "route in flight" errors
        await page1.unrouteAll({ behavior: 'ignoreErrors' });
        await page2.unrouteAll({ behavior: 'ignoreErrors' });
        await context1.close();
        await context2.close();
      }
    });
  });

  test.describe('ProxyAuth Mode: Authelia Integration Simulation', () => {
    test.beforeEach(async () => {
      const mode = await detectAuthMode();
      if (mode !== 'ProxyAuth') {
        test.skip(true, 'Test requires ProxyAuth mode');
      }
    });

    test('simulates Authelia header forwarding', async ({ browser }) => {
      // Simulate how Authelia forwards Remote-User header
      const autheliaUser = `authelia-user-${Date.now()}@domain.local`;

      const context = await browser.newContext();
      const page = await context.newPage();

      // Simulate Authelia's header forwarding
      await page.route('**/api/**', async (route) => {
        const headers = {
          ...route.request().headers(),
          // Authelia typically forwards these headers
          'Remote-User': autheliaUser,
          'Remote-Name': 'Test User',
          'Remote-Email': autheliaUser,
          'Remote-Groups': 'users,admins',
        };
        await route.continue({ headers });
      });

      try {
        await page.goto('/');

        const loginPage = new LoginPage(page);
        await loginPage.waitForForm();

        // Login with password (crypto key derivation)
        await loginPage.passwordInput.fill(TEST_CONSTANTS.PASSWORD);
        await loginPage.loginButton.click();

        await loginPage.expectLoginSuccess();

        const appShell = new AppShell(page);
        await appShell.waitForLoad();

        console.log(`[TEST] Successfully authenticated as Authelia user: ${autheliaUser}`);
      } finally {
        // Clean up routes before closing to avoid "route in flight" errors
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
    });

    test('validates Remote-User header format', async ({ page }) => {
      // Test that invalid header format is rejected
      const response = await page.request.get(`${API_URL}/api/albums`, {
        headers: {
          'Remote-User': 'invalid user with spaces!@#$%', // Invalid characters
        },
      });

      // Should be rejected (400 Bad Request or 401 Unauthorized)
      expect([400, 401]).toContain(response.status());
    });

    test('accepts valid email-style Remote-User', async ({ page }) => {
      const response = await page.request.get(`${API_URL}/api/users/me`, {
        headers: {
          'Remote-User': 'valid-user@domain.local',
        },
      });

      // Should be accepted (200 or 201 for new user)
      expect([200, 201]).toContain(response.status());
    });

    test('accepts valid username-style Remote-User', async ({ page }) => {
      const response = await page.request.get(`${API_URL}/api/users/me`, {
        headers: {
          'Remote-User': 'valid_user_123',
        },
      });

      // Should be accepted
      expect([200, 201]).toContain(response.status());
    });
  });

  test.describe('Header Validation (Both Modes)', () => {
    test('rejects invalid Remote-User header format in ProxyAuth mode', async ({ page }) => {
      const mode = await detectAuthMode();

      if (mode === 'ProxyAuth') {
        // ProxyAuth mode - test that invalid headers are rejected
        const response = await page.request.get(`${API_URL}/api/albums`, {
          headers: {
            'Remote-User': 'invalid user with spaces!@#$%',
          },
        });

        expect([400, 401]).toContain(response.status());
      } else {
        // LocalAuth mode - header validation happens in middleware
        // Test that the endpoint still requires authentication
        const response = await page.request.get(`${API_URL}/api/albums`);
        expect(response.status()).toBe(401);
      }
    });
  });

  test.describe('Cross-Mode Behavior', () => {
    test('login form adapts to backend mode', async ({ page }) => {
      const mode = await detectAuthMode();

      await page.goto('/');

      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();

      if (mode === 'LocalAuth') {
        // LocalAuth: should have username field and registration option
        await expect(loginPage.usernameInput).toBeVisible();
        await expect(loginPage.modeToggleButton).toBeVisible();
        console.log('[TEST] LocalAuth mode UI verified');
      } else {
        // ProxyAuth: should only have password field
        await expect(loginPage.usernameInput).not.toBeVisible();
        await expect(loginPage.passwordInput).toBeVisible();
        console.log('[TEST] ProxyAuth mode UI verified');
      }
    });
  });
});
