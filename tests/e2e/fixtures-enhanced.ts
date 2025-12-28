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
  SettingsPage,
  DeleteConfirmDialog,
  AdminPage,
} from './page-objects';

/**
 * Re-export all utilities
 */
export { expect } from '@playwright/test';
export * from './framework';
export * from './page-objects';

/**
 * Test constants
 */
export const TEST_CONSTANTS = {
  PASSWORD: TEST_PASSWORD,
  WRONG_PASSWORD: 'wrong-password-12345',
  EMPTY_PASSWORD: '',
};

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
   * Page that has completed the full login flow including crypto initialization
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
    await loginPage.login(TEST_PASSWORD);
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
 */
export async function loginUser(
  user: AuthenticatedUser,
  password: string = TEST_PASSWORD
): Promise<void> {
  await user.page.goto('/');
  const loginPage = new LoginPage(user.page);
  await loginPage.waitForForm();
  await loginPage.login(password);
  await loginPage.expectLoginSuccess();
}

/**
 * Helper to create an album via UI
 */
export async function createAlbumViaUI(
  page: Page,
  name: string
): Promise<void> {
  const appShell = new AppShell(page);
  await appShell.openCreateAlbumDialog();

  const dialog = new CreateAlbumDialog(page);
  await dialog.createAlbum(name);
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
const API_URL = process.env.API_URL || 'http://localhost:8080';

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

/**
 * Legacy LogCollector (simplified version)
 */
export class LogCollector {
  private logs: Array<{ timestamp: number; type: string; message: string }> = [];

  constructor(private page: Page) {
    this.attachListeners();
  }

  private attachListeners(): void {
    this.page.on('console', (msg) => {
      this.logs.push({
        timestamp: Date.now(),
        type: msg.type(),
        message: msg.text(),
      });
    });

    this.page.on('pageerror', (error) => {
      this.logs.push({
        timestamp: Date.now(),
        type: 'error',
        message: `Page error: ${error.message}`,
      });
    });
  }

  getLogs(): Array<{ timestamp: number; type: string; message: string }> {
    return [...this.logs];
  }

  getFormattedLogs(): string {
    return this.logs
      .map((log) => `${new Date(log.timestamp).toISOString()} [${log.type}]: ${log.message}`)
      .join('\n');
  }

  clear(): void {
    this.logs = [];
  }
}

/**
 * Alias exports for backward compatibility
 */
export { CreateAlbumDialog as CreateAlbumDialogPage };
