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
 */

import { test as base, expect, type Page, type ConsoleMessage, type Request, type Response } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Log capture types
 */
export interface CapturedLog {
  timestamp: number;
  type: 'console' | 'network-request' | 'network-response' | 'backend';
  level?: string;
  message: string;
  data?: unknown;
}

/**
 * Log collector that attaches to a page and collects logs
 */
export class LogCollector {
  private logs: CapturedLog[] = [];
  private page: Page;

  constructor(page: Page) {
    this.page = page;
    this.attachListeners();
  }

  private attachListeners() {
    // Capture console logs
    this.page.on('console', (msg: ConsoleMessage) => {
      this.logs.push({
        timestamp: Date.now(),
        type: 'console',
        level: msg.type(),
        message: msg.text(),
        data: msg.args().map(arg => arg.toString()),
      });
    });

    // Capture network requests
    this.page.on('request', (request: Request) => {
      if (request.url().includes('/api/')) {
        this.logs.push({
          timestamp: Date.now(),
          type: 'network-request',
          message: `${request.method()} ${request.url()}`,
          data: {
            headers: request.headers(),
            postData: request.postData(),
          },
        });
      }
    });

    // Capture network responses
    this.page.on('response', (response: Response) => {
      if (response.url().includes('/api/')) {
        this.logs.push({
          timestamp: Date.now(),
          type: 'network-response',
          level: response.status() >= 400 ? 'error' : 'info',
          message: `${response.status()} ${response.url()}`,
        });
      }
    });

    // Capture page errors
    this.page.on('pageerror', (error: Error) => {
      this.logs.push({
        timestamp: Date.now(),
        type: 'console',
        level: 'error',
        message: `Page error: ${error.message}`,
        data: error.stack,
      });
    });
  }

  /**
   * Get all captured logs
   */
  getLogs(): CapturedLog[] {
    return [...this.logs];
  }

  /**
   * Get logs as formatted string for test output
   */
  getFormattedLogs(): string {
    return this.logs
      .map(log => {
        const time = new Date(log.timestamp).toISOString();
        const level = log.level ? `[${log.level.toUpperCase()}]` : '';
        return `${time} ${log.type} ${level}: ${log.message}`;
      })
      .join('\n');
  }

  /**
   * Clear all logs
   */
  clear() {
    this.logs = [];
  }

  /**
   * Fetch backend container logs (for Docker environments)
   */
  static fetchBackendLogs(containerName = 'mosaic-test-backend', tail = 100): string {
    try {
      const result = execSync(`docker logs --tail ${tail} ${containerName} 2>&1`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return result;
    } catch (error) {
      return `Failed to fetch backend logs: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * API URL for backend requests
 */
const API_URL = process.env.API_URL || 'http://localhost:5000';

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
    // Wait for the form container to be visible
    await expect(this.page.getByTestId('login-form')).toBeVisible({ timeout: 30000 });
    // Wait for the form to finish loading (checkingAuthMode = false)
    // The password input only appears after auth mode is determined
    await expect(this.passwordInput).toBeVisible({ timeout: 30000 });
  }

  get loginForm() {
    return this.page.getByTestId('login-form');
  }

  get usernameInput() {
    // Support both English and Czech labels
    return this.page.getByLabel(/username|uživatelské jméno/i);
  }

  get passwordInput() {
    // Support both English and Czech labels
    return this.page.getByLabel(/^(Password|Heslo)$/i);
  }

  get confirmPasswordInput() {
    // Support both English and Czech labels
    return this.page.getByLabel(/confirm password|potvrzení hesla/i);
  }

  get loginButton() {
    // Support both English and Czech labels
    return this.page.getByRole('button', { name: /unlock|sign in|přihlásit se|odemknout/i });
  }

  get createAccountButton() {
    // Support both English and Czech labels
    return this.page.getByRole('button', { name: /create account|vytvořit účet/i }).first();
  }

  get modeToggleButton() {
    return this.page.getByRole('button', { name: /don't have an account|already have an account|nemáte účet|máte účet/i });
  }

  get errorMessage() {
    return this.page.getByRole('alert');
  }

  /**
   * Switch to registration mode
   */
  async switchToRegisterMode() {
    // Support both English and Czech labels
    const toggleBtn = this.page.getByRole('button', { name: /don't have an account|nemáte účet/i });
    if (await toggleBtn.isVisible().catch(() => false)) {
      await toggleBtn.click();
      // Wait for the registration form to fully appear
      await expect(this.confirmPasswordInput).toBeVisible({ timeout: 15000 });
    }
  }

  /**
   * Switch to login mode
   */
  async switchToLoginMode() {
    // Support both English and Czech labels
    const toggleBtn = this.page.getByRole('button', { name: /already have an account|máte již účet/i });
    if (await toggleBtn.isVisible().catch(() => false)) {
      await toggleBtn.click();
    }
  }

  /**
   * Register a new user with username and password.
   * This is required for LocalAuth mode where new users must be explicitly registered.
   */
  async register(username: string, password: string) {
    await this.switchToRegisterMode();
    
    const usernameField = this.usernameInput;
    if (await usernameField.isVisible().catch(() => false)) {
      await usernameField.clear();
      await usernameField.fill(username);
    }
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
    await this.createAccountButton.click();
  }

  /**
   * Login with username and password.
   * If username is provided, enters it in the username field.
   * This is required for LocalAuth mode where each test needs a unique username.
   */
  async login(password: string, username?: string) {
    console.log('[LoginPage] login() called');
    
    // Ensure we're in login mode (not register mode)
    await this.switchToLoginMode();
    console.log('[LoginPage] Switched to login mode');
    
    // If username provided, fill it in (LocalAuth mode)
    if (username) {
      const usernameField = this.usernameInput;
      if (await usernameField.isVisible().catch(() => false)) {
        await usernameField.clear();
        await usernameField.fill(username);
        console.log('[LoginPage] Filled username');
      }
    }
    await this.passwordInput.fill(password);
    console.log('[LoginPage] Filled password');
    
    // Wait for login button to be visible and enabled before clicking
    await expect(this.loginButton).toBeVisible({ timeout: 10000 });
    console.log('[LoginPage] Login button visible, clicking...');
    await this.loginButton.click();
    console.log('[LoginPage] Login button clicked');
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
    // Use specific class selector to avoid matching album cards that might contain "Lock" text
    return this.page.locator('button.logout-button');
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
 * Page Object Model for Create Album Dialog
 */
export class CreateAlbumDialogPage {
  constructor(private page: Page) {}

  get dialog() {
    return this.page.getByTestId('create-album-dialog');
  }

  get nameInput() {
    return this.page.getByTestId('album-name-input');
  }

  get createButton() {
    return this.page.getByTestId('create-button');
  }

  get cancelButton() {
    return this.page.getByTestId('cancel-button');
  }

  get errorMessage() {
    return this.page.getByTestId('create-album-error');
  }

  async waitForDialog() {
    await expect(this.dialog).toBeVisible({ timeout: 10000 });
  }

  async fillName(name: string) {
    await this.nameInput.fill(name);
  }

  async submit() {
    await this.createButton.click();
  }

  async cancel() {
    await this.cancelButton.click();
  }

  /**
   * Create an album with the given name
   */
  async createAlbum(name: string) {
    await this.waitForDialog();
    await this.fillName(name);
    await this.submit();
    // Wait for dialog to close
    await expect(this.dialog).toBeHidden({ timeout: 30000 });
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
    // Match both regular grid thumbnails and justified view thumbnails
    return this.page.locator('[data-testid="photo-thumbnail"], [data-testid="justified-photo-thumbnail"]');
  }

  get uploadButton() {
    return this.page.getByTestId('upload-button');
  }

  get fileInput() {
    return this.page.getByTestId('upload-input');
  }

  get emptyState() {
    return this.page.getByText(/no photos|upload|empty/i);
  }

  async uploadPhoto(imageBuffer: Buffer, filename = 'test.png') {
    // Use the testid to find the hidden file input
    const fileInput = this.page.getByTestId('upload-input');
    
    // Wait for file input to be attached to DOM
    await expect(fileInput).toBeAttached({ timeout: 10000 });
    console.log('[GalleryPage] File input found, setting files...');
    
    // Capture current photo count before upload
    const countBefore = await this.photos.count();
    console.log(`[GalleryPage] Photo count before upload: ${countBefore}`);
    
    // Set files on the hidden input - Playwright handles this even when display:none
    await fileInput.setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: imageBuffer,
    });
    console.log('[GalleryPage] Files set successfully, waiting for upload to complete...');
    
    // Wait for upload button to show "Uploading" state first
    try {
      await this.page.waitForFunction(() => {
        const btn = document.querySelector('[data-testid="upload-button"]');
        return btn?.textContent?.includes('Uploading');
      }, { timeout: 5000 });
      console.log('[GalleryPage] Upload started (button shows Uploading)');
    } catch {
      console.log('[GalleryPage] Warning: Never saw Uploading state, continuing...');
    }
    
    // Wait for upload button to finish uploading (not show "Uploading" text)
    await this.page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="upload-button"]');
      const isUploading = btn?.textContent?.includes('Uploading');
      return btn && !isUploading;
    }, { timeout: 60000 });
    
    console.log('[GalleryPage] Upload appears complete, waiting for photo to render...');
    
    // Check count after upload completes
    const countAfterUpload = await this.photos.count();
    console.log(`[GalleryPage] Photo count after upload complete: ${countAfterUpload}`);
    
    // Wait for photo count to increase by 1
    const expectedCount = countBefore + 1;
    console.log(`[GalleryPage] Expecting count to reach: ${expectedCount}`);
    
    await expect(this.photos).toHaveCount(expectedCount, { timeout: 60000 });
    
    const currentCount = await this.photos.count();
    console.log(`[GalleryPage] Photo rendered. Final count: ${currentCount}`);
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
