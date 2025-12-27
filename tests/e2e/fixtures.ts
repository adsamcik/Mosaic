/**
 * Test fixtures and page object models for Mosaic E2E tests.
 * 
 * Phase 1 Implementation:
 * - Fixed soft assertions
 * - Added proper wait utilities
 * - Created core fixtures for P0 tests
 */

import { test as base, expect, type Page } from '@playwright/test';

/**
 * API URL for backend requests
 */
const API_URL = process.env.API_URL || 'http://localhost:8080';

/**
 * Test password used for E2E testing
 */
const TEST_PASSWORD = 'test-password-e2e-2024';

/**
 * Generate a 1x1 red pixel PNG for testing
 */
export function generateTestImage(): Buffer {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  return Buffer.from(base64, 'base64');
}

/**
 * Extended test fixtures
 */
export const test = base.extend<{
  authenticatedPage: Page;
  testUser: string;
  loggedInPage: Page;
  twoUserContext: { alice: Page; bob: Page; aliceUser: string; bobUser: string };
}>({
  /**
   * Generate a unique test user for each test
   */
  testUser: async ({}, use) => {
    const user = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    await use(user);
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
    const loginForm = page.getByTestId('login-form');
    await expect(loginForm).toBeVisible({ timeout: 30000 });
    
    // Fill password and submit
    const passwordInput = page.getByLabel('Password');
    await passwordInput.fill(TEST_PASSWORD);
    
    const loginButton = page.getByRole('button', { name: /unlock/i });
    await loginButton.click();
    
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
    const aliceUser = `alice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const bobUser = `bob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    
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
 * Test constants
 */
export const TEST_CONSTANTS = {
  PASSWORD: TEST_PASSWORD,
  WRONG_PASSWORD: 'wrong-password-12345',
  EMPTY_PASSWORD: '',
};

/**
 * Page Object Model for the Login page
 */
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/');
  }

  async waitForForm() {
    await expect(this.page.getByTestId('login-form')).toBeVisible({ timeout: 30000 });
  }

  get loginForm() {
    return this.page.getByTestId('login-form');
  }

  get passwordInput() {
    return this.page.getByLabel('Password');
  }

  get loginButton() {
    return this.page.getByRole('button', { name: /unlock/i });
  }

  get errorMessage() {
    return this.page.getByRole('alert');
  }

  async login(password: string) {
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  async expectErrorMessage(text?: string | RegExp) {
    await expect(this.errorMessage).toBeVisible({ timeout: 10000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectLoginSuccess() {
    // Wait for app shell to appear, indicating successful login
    await expect(this.page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });
  }

  async expectLoginFormVisible() {
    await expect(this.loginForm).toBeVisible({ timeout: 30000 });
  }
}

/**
 * Page Object Model for the App Shell
 */
export class AppShell {
  constructor(private page: Page) {}

  async waitForLoad() {
    await expect(this.page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });
  }

  get shell() {
    return this.page.getByTestId('app-shell');
  }

  get albumList() {
    return this.page.getByTestId('album-list');
  }

  get createAlbumButton() {
    return this.page.getByRole('button', { name: /create album|new album|\+/i });
  }

  get logoutButton() {
    return this.page.getByRole('button', { name: /lock|logout/i });
  }

  get backToAlbumsButton() {
    return this.page.getByRole('button', { name: /albums/i });
  }

  async logout() {
    await this.logoutButton.click();
  }

  async createAlbum() {
    await this.createAlbumButton.click();
  }

  async expectAlbumListVisible() {
    await expect(this.albumList).toBeVisible({ timeout: 10000 });
  }

  async expectEmptyState() {
    const emptyMessage = this.page.getByText(/no albums|create.*album|get started/i);
    await expect(emptyMessage.first()).toBeVisible({ timeout: 10000 });
  }
}

/**
 * Page Object Model for Gallery view
 */
export class GalleryPage {
  constructor(private page: Page) {}

  async waitForLoad() {
    await expect(this.page.getByTestId('gallery')).toBeVisible({ timeout: 30000 });
  }

  get gallery() {
    return this.page.getByTestId('gallery');
  }

  get photoGrid() {
    return this.page.getByTestId('photo-grid');
  }

  get photos() {
    return this.page.getByTestId('photo-thumbnail');
  }

  get uploadButton() {
    return this.page.getByTestId('upload-button');
  }

  get fileInput() {
    return this.page.locator('input[type="file"]');
  }

  get emptyState() {
    return this.page.getByText(/no photos|upload|empty/i);
  }

  async uploadPhoto(imageBuffer: Buffer, filename = 'test.png') {
    await this.fileInput.setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: imageBuffer,
    });
  }

  async expectPhotoCount(count: number) {
    await expect(this.photos).toHaveCount(count, { timeout: 30000 });
  }

  async expectEmptyState() {
    await expect(this.emptyState.first()).toBeVisible({ timeout: 10000 });
  }

  async expectUploadButtonVisible() {
    await expect(this.uploadButton).toBeVisible({ timeout: 10000 });
  }

  async selectPhoto(index: number) {
    const photos = await this.photos.all();
    if (photos[index]) {
      await photos[index].click();
    }
  }
}

/**
 * API helper for setting up test data
 */
export class ApiHelper {
  constructor(private baseUrl: string = API_URL) {}

  async createAlbum(user: string): Promise<{ id: string }> {
    const response = await fetch(`${this.baseUrl}/api/albums`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Remote-User': user,
      },
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
