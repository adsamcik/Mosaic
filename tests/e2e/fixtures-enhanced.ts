/**
 * Enhanced E2E Test Fixtures
 *
 * This file provides parallel-safe fixtures using the new test framework.
 * It re-exports all page objects and utilities for convenient importing.
 */

import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  TestContext,
  CollaborationContext,
  createCollaborationContext,
  generateTestImage,
  createAlbumViaAPI,
  TEST_PASSWORD,
  waitForCryptoReady,
  type AuthenticatedUser,
} from './framework';
import {
  LoginPage,
  AppShell,
  CreateAlbumDialog,
  GalleryPage,
  Lightbox,
  MembersPanel,
  InviteMemberDialog,
  RemoveMemberDialog,
  SettingsPage,
  DeleteConfirmDialog,
  DeleteAlbumDialog,
  AdminPage,
} from './page-objects';

/**
 * Re-export all utilities
 */
export { expect } from '@playwright/test';
export * from './framework';
export * from './page-objects';

// TEST_CONSTANTS is now exported via 'export * from ./framework'
// Single source of truth is framework/constants.ts

/**
 * Isolated test context fixture
 */
export interface IsolatedTestFixtures {
  testContext: TestContext;
  alice: AuthenticatedUser;
}

/**
 * Collaboration test fixture
 */
export interface CollaborationTestFixtures {
  collaboration: CollaborationContext;
}

/**
 * Extended test with all fixtures
 */
export const test = base.extend<{
  // Legacy fixtures (for backward compatibility)
  authenticatedPage: Page;
  testUser: string;
  loggedInPage: Page;
  twoUserContext: { alice: Page; bob: Page; aliceUser: string; bobUser: string };

  // New parallel-safe fixtures
  testContext: TestContext;
  isolatedUser: AuthenticatedUser;
  collaboration: CollaborationContext;
}>({
  /**
   * Generate a unique test user for each test (legacy)
   */
  testUser: async ({}, use) => {
    const user = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    await use(user);
  },

  /**
   * Page with authentication headers set (API-level auth only)
   */
  authenticatedPage: async ({ page, testUser }, use) => {
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
   * Page that has completed the full login flow including crypto initialization.
   * Handles both LocalAuth and ProxyAuth modes automatically.
   */
  loggedInPage: async ({ browser, testUser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': testUser,
      };
      await route.continue({ headers });
    });

    await page.goto('/');

    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();

    // Detect auth mode by checking for username field (use i18n-compatible locator from LoginPage)
    const isLocalAuth = await loginPage.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

    if (isLocalAuth) {
      // LocalAuth mode: register new user (test users are always new)
      await loginPage.register(testUser, TEST_PASSWORD);
    } else {
      // ProxyAuth-only mode: just enter password
      await loginPage.login(TEST_PASSWORD);
    }

    await loginPage.expectLoginSuccess();

    await use(page);
    await context.close();
  },

  /**
   * Two authenticated users for sharing tests (legacy)
   */
  twoUserContext: async ({ browser }, use) => {
    const aliceUser = `alice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const bobUser = `bob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;

    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();

    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': aliceUser,
      };
      await route.continue({ headers });
    });

    await bob.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': bobUser,
      };
      await route.continue({ headers });
    });

    await use({ alice, bob, aliceUser, bobUser });

    await aliceContext.close();
    await bobContext.close();
  },

  /**
   * NEW: Parallel-safe test context with automatic cleanup
   */
  testContext: async ({ browser }, use, testInfo) => {
    const ctx = new TestContext(browser, testInfo.parallelIndex);

    await use(ctx);

    // Automatic cleanup after test
    await ctx.cleanup();
  },

  /**
   * NEW: Single isolated user with authenticated page
   */
  isolatedUser: async ({ testContext }, use) => {
    const user = await testContext.createAuthenticatedUser('main');
    await use(user);
  },

  /**
   * NEW: Two-user collaboration context with cleanup
   */
  collaboration: async ({ browser }, use, testInfo) => {
    const ctx = await createCollaborationContext(browser, testInfo.parallelIndex);

    await use(ctx);

    // Automatic cleanup
    await ctx.cleanup();
  },
});

/**
 * Helper to create a fully logged-in user
 *
 * Handles both LocalAuth and ProxyAuth modes:
 * - LocalAuth: Registers the user if they don't exist, otherwise logs in with username
 * - ProxyAuth-only: Just enters password (username comes from Remote-User header)
 * 
 * Note: If createAlbumViaAPI is called before this function, the backend may auto-create
 * the user from the Remote-User header. In that case, registration will fail and we
 * automatically fall back to login mode.
 */
export async function loginUser(
  user: AuthenticatedUser,
  password: string = TEST_PASSWORD
): Promise<void> {
  await user.page.goto('/');
  const loginPage = new LoginPage(user.page);
  await loginPage.waitForForm();

  // Detect auth mode by checking for username field (use i18n-compatible locator from LoginPage)
  const isLocalAuth = await loginPage.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);

  if (isLocalAuth) {
    // LocalAuth mode: try to register, but fall back to login if user already exists
    // (happens when createAlbumViaAPI is called before loginUser)
    await loginPage.register(user.email, password);
    
    // Wait a moment for potential error to appear, then check
    // Use Promise.race to either see the app-shell (success) or error (failure)
    const successOrError = await Promise.race([
      loginPage.page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 5000 })
        .then(() => 'success' as const)
        .catch(() => null),
      loginPage.errorMessage.waitFor({ state: 'visible', timeout: 5000 })
        .then(() => 'error' as const)
        .catch(() => null),
    ]);

    if (successOrError === 'error') {
      // Registration failed - check if it's "already taken" error
      const errorText = await loginPage.errorMessage.textContent() ?? '';
      if (errorText.toLowerCase().includes('already taken') || errorText.toLowerCase().includes('already exists')) {
        // User exists from API call - switch to login mode
        await loginPage.switchToLoginMode();
        await loginPage.loginWithUsername(user.email, password);
      }
    }
    // If success, we continue to expectLoginSuccess
    // If neither, we also continue (might timeout later)
  } else {
    // ProxyAuth-only mode: just enter password to initialize crypto
    await loginPage.login(password);
  }

  await loginPage.expectLoginSuccess();
}

/**
 * Helper to create an album via UI and navigate into it
 */
export async function createAlbumViaUI(
  page: Page,
  name: string
): Promise<void> {
  const appShell = new AppShell(page);
  await appShell.openCreateAlbumDialog();

  const dialog = new CreateAlbumDialog(page);
  await dialog.createAlbum(name);
  
  // Wait for album card to appear and click it to enter the album
  const albumCard = page.getByTestId('album-card').first();
  await expect(albumCard).toBeVisible({ timeout: 10000 });
  await albumCard.click();
  
  // Wait for gallery to load
  const gallery = new GalleryPage(page);
  await gallery.waitForLoad();
}

/**
 * Helper to reload page and re-login if needed.
 * After creating albums via API, we need to reload to see them.
 * Session may persist (no login needed) or require password unlock.
 */
export async function reloadAndEnsureLoggedIn(
  page: Page,
  password: string = TEST_PASSWORD
): Promise<void> {
  await page.reload();
  
  // Wait for either login form or app shell to appear
  const loginForm = page.getByTestId('login-form');
  const appShell = page.getByTestId('app-shell');
  
  // Wait for one of them to be visible
  await expect(loginForm.or(appShell)).toBeVisible({ timeout: 10000 });
  
  // Check which one is visible
  const isLoggedIn = await appShell.isVisible().catch(() => false);
  
  if (!isLoggedIn) {
    const loginPage = new LoginPage(page);
    await loginPage.waitForForm();
    await loginPage.login(password);
    await loginPage.expectLoginSuccess();
  }
}

/**
 * Helper to navigate to an album
 */
export async function navigateToAlbum(
  page: Page,
  albumNameOrIndex: string | number
): Promise<void> {
  const appShell = new AppShell(page);

  if (typeof albumNameOrIndex === 'number') {
    await appShell.clickAlbum(albumNameOrIndex);
  } else {
    await appShell.clickAlbumByName(albumNameOrIndex);
  }

  const gallery = new GalleryPage(page);
  await gallery.waitForLoad();
}

/**
 * Helper to upload a photo to the current album
 */
export async function uploadPhoto(
  page: Page,
  filename?: string
): Promise<void> {
  const gallery = new GalleryPage(page);
  const testImage = generateTestImage('tiny');
  await gallery.uploadPhoto(testImage, filename || 'test-photo.png');
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

export async function mockApiError(
  page: Page,
  urlPattern: string,
  status: number,
  body = {}
): Promise<void> {
  await page.route(urlPattern, (route) => {
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

/**
 * Legacy API Helper (re-implemented for independence)
 */
import { API_URL } from './framework/constants';

export class ApiHelper {
  constructor(private baseUrl: string = API_URL) {}

  async createAlbum(user: string): Promise<{ id: string }> {
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
      headers: { 'Remote-User': user },
    });

    if (!response.ok) {
      throw new Error(`Failed to get albums: ${response.status}`);
    }

    return response.json();
  }

  async deleteAlbum(user: string, albumId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/albums/${albumId}`, {
      method: 'DELETE',
      headers: { 'Remote-User': user },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete album: ${response.status}`);
    }
  }

  async getCurrentUser(user: string): Promise<{ id: string; authSub: string }> {
    const response = await fetch(`${this.baseUrl}/api/users/me`, {
      headers: { 'Remote-User': user },
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

// Re-export LogCollector from framework (authoritative implementation)
export { LogCollector } from './framework';

/**
 * Alias exports for backward compatibility
 */
export { CreateAlbumDialog as CreateAlbumDialogPage };
