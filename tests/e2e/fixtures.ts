/**
 * Test fixtures and page object models for Mosaic E2E tests.
 * 
 * Phase 1 Implementation:
 * - Fixed soft assertions
 * - Added proper wait utilities
 * - Created core fixtures for P0 tests
 * 
 * Phase 2:
 * - Added log capture infrastructure (browser console, network, backend)
 * - Added CreateAlbumDialog page object for browser-based album creation
 * 
 * Phase 3:
 * - Added TestAPIClient for server-side user creation
 * - This bypasses browser-based registration to avoid Argon2 parameter mismatches
 * 
 * Phase 4:
 * - Consolidated page objects into separate modules
 * - Page objects are now re-exported from ./page-objects
 */

import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { POOL_USERS } from './auth-setup';

// Re-export page objects from the modular structure
import {
  LoginPage,
  AppShell,
  CreateAlbumDialog,
  GalleryPage,
} from './page-objects';

// Re-export page objects for test files
export { LoginPage, AppShell, GalleryPage };
// Backward compatibility alias - some tests use CreateAlbumDialogPage
export { CreateAlbumDialog as CreateAlbumDialogPage };

// Re-export LogCollector and TestAPIClient from framework
export { LogCollector, TestAPIClient } from './framework';

// Re-export generateTestImage from framework (authoritative source)
export { generateTestImage } from './framework';

// Re-export TEST_CONSTANTS from framework (single source of truth)
export { TEST_CONSTANTS } from './framework';

// Import from centralized constants
import { API_URL, BASE_URL, TEST_PASSWORD } from './framework/constants';

// Re-export for backward compatibility
export { API_URL, BASE_URL };

// Import TestAPIClient for use in fixtures
import { TestAPIClient } from './framework';

/**
 * Get pool user for a specific worker index.
 * 
 * IMPORTANT: We use workerIndex instead of a module-level counter because
 * Playwright workers run in separate Node.js processes. A module-level counter
 * would start at 0 in each process, causing all workers to use the same pool user.
 * 
 * Using workerIndex ensures each parallel worker gets a different pool user,
 * preventing session conflicts and race conditions.
 */
function getPoolUserByWorkerIndex(workerIndex: number): typeof POOL_USERS[number] {
  return POOL_USERS[workerIndex % POOL_USERS.length];
}

/**
 * Extended test fixtures
 */
export const test = base.extend<{
  authenticatedPage: Page;
  testUser: string;
  loggedInPage: Page;
  twoUserContext: { alice: Page; bob: Page; aliceUser: string; bobUser: string };
  poolUser: { page: Page; username: string };
  poolUserPage: Page;
}>({
  /**
   * Generate a unique test user for each test
   */
  testUser: async ({}, use) => {
    const user = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.local`;
    await use(user);
  },

  /**
   * Pool user fixture for fast test execution.
   * 
   * Pool users are pre-registered in global-setup, so we just need to login.
   * IMPORTANT: We do NOT use stored browser state because:
   * - Crypto keys are stored in OPFS (browser-specific), not in storageState
   * - A fresh login is required to derive and store crypto keys in each context
   * 
   * This is still faster than unique users because:
   * - No registration flow (user exists)
   * - Login is faster than register (no key derivation from scratch)
   * 
   * NOTE: We use workerInfo.workerIndex to assign pool users because Playwright
   * workers run in separate processes. This ensures each parallel worker gets
   * a unique pool user, preventing session conflicts.
   * 
   * NOTE: Pool users are only supported on chromium project. Mobile-chrome has
   * Argon2 key derivation differences that prevent decrypting keys created by
   * chromium. Tests using poolUser will be skipped on mobile-chrome.
   */
  poolUser: async ({ browser }, use, workerInfo) => {
    // Skip pool users on mobile-chrome - Argon2 WASM produces different key derivation
    // results on mobile viewport, causing "Invalid username or password" errors.
    // See investigation: Pool users are registered via chromium in global-setup,
    // but mobile-chrome's Argon2 derives different keys, so decryption fails.
    const projectName = workerInfo.project.name;
    if (projectName === 'mobile-chrome') {
      throw new Error(
        `Pool users are not supported on ${projectName}. ` +
        'Use testUser fixture instead, or skip this test on mobile-chrome. ' +
        'Root cause: Argon2 key derivation differs between browser types.'
      );
    }
    
    const user = getPoolUserByWorkerIndex(workerInfo.workerIndex);
    console.log(`[Fixture] Worker ${workerInfo.workerIndex} using pool user: ${user.username}`);
    
    // Create a fresh browser context
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Use the test API to create/get the user with a session cookie
    const testApi = new TestAPIClient();
    try {
      const authResponse = await testApi.createAuthenticatedUser(user.username);
      console.log(`[Fixture] Created/got user via API: ${user.username} (wasCreated: ${authResponse.wasCreated})`);
      
      // Apply auth to context (sets session cookie)
      await testApi.applyAuthToContext(context, authResponse);
      
      // Navigate to app
      await page.goto('/');
      
      // Setup localStorage with user salt
      await testApi.setupLocalStorage(page, authResponse);
      
      // Reload to ensure app recognizes the session
      await page.reload();
      
      // Now we should see either:
      // 1. Password unlock form (user has session but needs to unlock vault)
      // 2. Login form (if session cookie didn't work properly)
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      
      // The app should show the password form since we have a session
      // but the crypto vault needs to be unlocked
      // Use loginOrRegister to handle any edge case
      await loginPage.loginOrRegister(TEST_PASSWORD, user.username);
      
      // Wait for app shell - confirms login and crypto init complete
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });
      console.log(`[Fixture] Pool user ${user.username} ready (worker ${workerInfo.workerIndex})`);
      
    } catch (apiError) {
      console.log(`[Fixture] API setup failed, falling back to browser-based auth: ${apiError}`);
      // Fallback to browser-based registration if API fails
      await page.goto('/');
      const loginPage = new LoginPage(page);
      await loginPage.waitForForm();
      await loginPage.loginOrRegister(TEST_PASSWORD, user.username);
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });
    }
    
    await use({ page, username: user.username });
    
    await context.close();
  },

  /**
   * Convenience fixture that just returns the page from poolUser
   */
  poolUserPage: async ({ poolUser }, use) => {
    await use(poolUser.page);
  },

  /**
   * Page with authentication headers set (API-level auth only)
   */
  authenticatedPage: async ({ page, testUser }, use) => {
    // Set up route to inject auth header for API calls
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    await use(page);
  },

  /**
   * Page that has completed the full login flow including crypto initialization
   */
  loggedInPage: async ({ browser, testUser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Inject auth headers for API calls
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    // Navigate to app and complete login
    await page.goto('/');
    
    // Wait for login form
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    
    // Check if LocalAuth mode (has username field) using i18n-compatible locator
    const isLocalAuth = await loginPage.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth) {
      // LocalAuth mode: register a new user (tests use unique usernames)
      await loginPage.register(testUser, TEST_PASSWORD);
    } else {
      // ProxyAuth mode: just enter password
      await loginPage.login(TEST_PASSWORD);
    }
    
    // Wait for app shell to appear (indicates successful login)
    const appShell = page.getByTestId('app-shell');
    await expect(appShell).toBeVisible({ timeout: 60000 });
    
    await use(page);
    
    // Cleanup
    await context.close();
  },

  /**
   * Two authenticated users for sharing tests
   */
  twoUserContext: async ({ browser }, use) => {
    const aliceUser = `alice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.local`;
    const bobUser = `bob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2e.local`;
    
    // Create contexts for both users
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    
    // Set up auth routes for Alice
    await alice.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': aliceUser,
      };
      await route.continue({ headers });
    });
    
    // Set up auth routes for Bob
    await bob.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': bobUser,
      };
      await route.continue({ headers });
    });
    
    await use({ alice, bob, aliceUser, bobUser });
    
    // Cleanup
    await aliceContext.close();
    await bobContext.close();
  },
});

export { expect };

/**
 * API helper for setting up test data
 */
export class ApiHelper {
  constructor(private baseUrl: string = API_URL) {}

  async createAlbum(user: string): Promise<{ id: string }> {
    // Generate dummy crypto data - backend stores but doesn't validate crypto content
    const dummyBytes32 = Buffer.alloc(32).toString('base64');
    const dummyBytes64 = Buffer.alloc(64).toString('base64');

    const response = await fetch(`${this.baseUrl}/api/albums`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Remote-User': user,
      },
      body: JSON.stringify({
        initialEpochKey: {
          encryptedKeyBundle: dummyBytes32,
          ownerSignature: dummyBytes64,
          sharerPubkey: dummyBytes32,
          signPubkey: dummyBytes32,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create album: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  async getAlbums(user: string): Promise<{ id: string }[]> {
    const response = await fetch(`${this.baseUrl}/api/albums`, {
      headers: {
        'Remote-User': user,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get albums: ${response.status}`);
    }

    return response.json();
  }

  async deleteAlbum(user: string, albumId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/albums/${albumId}`, {
      method: 'DELETE',
      headers: {
        'Remote-User': user,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete album: ${response.status}`);
    }
  }

  async getCurrentUser(user: string): Promise<{ id: string; authSub: string }> {
    const response = await fetch(`${this.baseUrl}/api/users/me`, {
      headers: {
        'Remote-User': user,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get user: ${response.status}`);
    }

    return response.json();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Network utilities
 */
export async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
}

export async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false);
}

export async function mockApiError(page: Page, urlPattern: string, status: number, body = {}): Promise<void> {
  await page.route(urlPattern, (route) => {
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}
