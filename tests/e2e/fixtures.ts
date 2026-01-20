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
 */

import { test as base, expect, type Page, type ConsoleMessage, type Request, type Response, type BrowserContext } from '@playwright/test';
import { execSync } from 'child_process';
import { POOL_USERS } from './auth-setup';

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
 * Frontend URL
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

/**
 * Response from create-authenticated-user API
 */
interface CreateAuthenticatedUserResponse {
  id: string;
  email: string;
  wasCreated: boolean;
  userSalt: string;
  accountSalt: string;
  sessionToken: string;
}

/**
 * Test API client for managing test users without browser automation.
 * This bypasses the browser-based registration/login flow, avoiding
 * Argon2 parameter mismatches between different browser types.
 */
export class TestAPIClient {
  private apiUrl: string;

  constructor(apiUrl = API_URL) {
    this.apiUrl = apiUrl;
  }

  /**
   * Create an authenticated user and get a session cookie.
   * The user is created on the backend with all necessary fields.
   * Returns the session token and user salts.
   */
  async createAuthenticatedUser(email: string): Promise<CreateAuthenticatedUserResponse> {
    const response = await fetch(`${this.apiUrl}/api/test-seed/create-authenticated-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create authenticated user: ${response.status} ${text}`);
    }

    return response.json();
  }

  /**
   * Apply authentication to a browser context.
   * This sets the session cookie and localStorage values needed for the app.
   */
  async applyAuthToContext(
    context: BrowserContext,
    authResponse: CreateAuthenticatedUserResponse
  ): Promise<void> {
    // Set the session cookie
    await context.addCookies([
      {
        name: 'mosaic_session',
        value: authResponse.sessionToken,
        domain: new URL(this.apiUrl).hostname,
        path: '/api',
        httpOnly: true,
        secure: false, // Development mode
        sameSite: 'Lax',
      },
    ]);

    // We also need to set localStorage for the app to recognize the user
    // This is done via page.evaluate after navigation
  }

  /**
   * Setup localStorage after page navigation.
   * Must be called after page.goto() since localStorage is per-origin.
   */
  async setupLocalStorage(
    page: Page,
    authResponse: CreateAuthenticatedUserResponse
  ): Promise<void> {
    await page.evaluate(
      ({ userSalt }) => {
        localStorage.setItem('mosaic:userSalt', userSalt);
      },
      { userSalt: authResponse.userSalt }
    );
  }

  /**
   * Full setup: create user, apply auth to context, navigate, and setup localStorage.
   * After this, the user only needs to enter their password to unlock the vault.
   */
  async setupAuthenticatedUser(
    context: BrowserContext,
    page: Page,
    email: string
  ): Promise<CreateAuthenticatedUserResponse> {
    const authResponse = await this.createAuthenticatedUser(email);
    await this.applyAuthToContext(context, authResponse);
    
    // Navigate to app
    await page.goto(BASE_URL);
    
    // Setup localStorage
    await this.setupLocalStorage(page, authResponse);
    
    // Reload to apply localStorage
    await page.reload();
    
    return authResponse;
  }
}

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
   * Switch to registration mode (only if currently in login mode)
   */
  async switchToRegisterMode() {
    // Check if we're already in register mode by checking if confirm password field is visible
    const isAlreadyInRegisterMode = await this.confirmPasswordInput.isVisible().catch(() => false);
    if (isAlreadyInRegisterMode) {
      console.log('[LoginPage] Already in register mode, skipping switch');
      return;
    }
    
    // Support both English and Czech labels
    const toggleBtn = this.page.getByRole('button', { name: /don't have an account|nemáte účet/i });
    // Wait for toggle button to be visible with timeout
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });
    await toggleBtn.click();
    // Wait for the registration form to fully appear
    await expect(this.confirmPasswordInput).toBeVisible({ timeout: 15000 });
  }

  /**
   * Switch to login mode (only if currently in register mode)
   */
  async switchToLoginMode() {
    // Check if we're already in login mode by checking if confirm password field is hidden
    const isAlreadyInLoginMode = !(await this.confirmPasswordInput.isVisible().catch(() => false));
    if (isAlreadyInLoginMode) {
      console.log('[LoginPage] Already in login mode, skipping switch');
      return;
    }
    
    // Support both English and Czech labels
    const toggleBtn = this.page.getByRole('button', { name: /already have an account|máte účet/i });
    // Wait for toggle button to be visible with timeout
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });
    await toggleBtn.click();
    // Wait for the form to switch - confirm password field should disappear
    await expect(this.confirmPasswordInput).toBeHidden({ timeout: 5000 });
  }

  /**
   * Register a new user with username and password.
   * This is required for LocalAuth mode where new users must be explicitly registered.
   */
  async register(username: string, password: string) {
    await this.switchToRegisterMode();
    
    // Wait for and fill username field
    await expect(this.usernameInput).toBeVisible({ timeout: 5000 });
    await this.usernameInput.clear();
    await this.usernameInput.fill(username);

    // Fill password fields
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);

    // Click create account button
    await expect(this.createAccountButton).toBeVisible({ timeout: 5000 });
    await this.createAccountButton.click();
  }

  /**
   * Login with username and password.
   * In LocalAuth mode (username field visible), username is required.
   * In ProxyAuth mode (no username field), only password is needed.
   */
  async login(password: string, username?: string) {
    console.log('[LoginPage] login() called');
    
    // Ensure we're in login mode (not register mode)
    await this.switchToLoginMode();
    console.log('[LoginPage] Switched to login mode');
    
    // Check if LocalAuth mode (username field visible)
    const isLocalAuth = await this.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth) {
      if (!username) {
        throw new Error('[LoginPage] LocalAuth mode detected but no username provided. Call login(password, username) or use register() for new users.');
      }
      await this.usernameInput.clear();
      await this.usernameInput.fill(username);
      console.log('[LoginPage] Filled username');
    }
    
    await this.passwordInput.fill(password);
    console.log('[LoginPage] Filled password');
    
    // Wait for login button to be visible and enabled before clicking
    await expect(this.loginButton).toBeVisible({ timeout: 10000 });
    console.log('[LoginPage] Login button visible, clicking...');
    await this.loginButton.click();
    console.log('[LoginPage] Login button clicked');
  }

  /**
   * Login with username and password (username first signature).
   * Convenience wrapper around login() for tests that prefer username-first.
   */
  async loginWithUsername(username: string, password: string = TEST_PASSWORD) {
    await this.login(password, username);
  }

  /**
   * Login or register based on auth mode.
   * - In LocalAuth mode: tries to register, falls back to login if user exists
   * - In ProxyAuth mode: just enters the password
   * This is the recommended method for tests that need to complete login.
   */
  async loginOrRegister(password: string, username: string) {
    console.log('[LoginPage] loginOrRegister() called');
    
    // Check if LocalAuth mode (username field visible)
    const isLocalAuth = await this.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth) {
      console.log('[LoginPage] LocalAuth mode detected, attempting registration');
      await this.register(username, password);
      
      // Wait for either success (app-shell) or error (alert)
      const appShell = this.page.getByTestId('app-shell');
      const errorAlert = this.errorMessage;
      
      // Race: wait for either app-shell or error to appear
      const result = await Promise.race([
        appShell.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'success'),
        errorAlert.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'error'),
      ]).catch(() => 'timeout');
      
      console.log(`[LoginPage] Registration result: ${result}`);
      
      if (result === 'error') {
        const errorText = await this.errorMessage.textContent();
        console.log(`[LoginPage] Error text: ${errorText}`);
        if (errorText?.toLowerCase().includes('already taken') || errorText?.toLowerCase().includes('already exists')) {
          console.log('[LoginPage] User already exists, switching to login');
          await this.switchToLoginMode();
          await this.usernameInput.clear();
          await this.usernameInput.fill(username);
          await this.passwordInput.fill(password);
          await expect(this.loginButton).toBeVisible({ timeout: 10000 });
          await this.loginButton.click();
        }
      }
      // If 'success', registration worked, nothing more to do
      // If 'timeout', let the caller handle it
    } else {
      console.log('[LoginPage] ProxyAuth mode detected, logging in');
      await this.passwordInput.fill(password);
      await expect(this.loginButton).toBeVisible({ timeout: 10000 });
      await this.loginButton.click();
    }
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

  /**
   * Just set a file on the upload input without waiting for photo to appear.
   * Use this with page.waitForResponse() when working around the sync bug.
   */
  async setFileInput(imageBuffer: Buffer, filename = 'test.png') {
    // Wait for upload button to be visible and enabled
    const uploadButton = this.page.getByTestId('upload-button');
    await expect(uploadButton).toBeVisible({ timeout: 10000 });
    await expect(uploadButton).toBeEnabled({ timeout: 10000 });
    
    // Use the testid to find the hidden file input
    const fileInput = this.page.getByTestId('upload-input');
    await expect(fileInput).toBeAttached({ timeout: 10000 });
    
    // Set files on the hidden input
    await fileInput.setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: imageBuffer,
    });
  }

  async uploadPhoto(imageBuffer: Buffer, filename = 'test.png') {
    // Wait for upload button to be visible and enabled (ensures component is hydrated)
    const uploadButton = this.page.getByTestId('upload-button');
    await expect(uploadButton).toBeVisible({ timeout: 10000 });
    await expect(uploadButton).toBeEnabled({ timeout: 10000 });
    const initialButtonText = await uploadButton.textContent();
    console.log(`[GalleryPage] Upload button ready, text: "${initialButtonText}"`);
    
    // Use the testid to find the hidden file input
    const fileInput = this.page.getByTestId('upload-input');
    
    // Wait for file input to be attached to DOM
    await expect(fileInput).toBeAttached({ timeout: 10000 });
    console.log('[GalleryPage] File input found');
    
    // Capture current photo count before upload
    const countBefore = await this.photos.count();
    console.log(`[GalleryPage] Photo count before upload: ${countBefore}`);
    
    const expectedCount = countBefore + 1;
    const startTime = Date.now();
    
    // Set files on the hidden input - Playwright handles this even when display:none
    // WORKAROUND: Sometimes the first setInputFiles doesn't trigger the change event
    // in Docker/CI environments. We try up to 3 times with verification.
    let uploadTriggered = false;
    for (let attempt = 1; attempt <= 3 && !uploadTriggered; attempt++) {
      console.log(`[GalleryPage] Setting files attempt #${attempt} at T+${Date.now() - startTime}ms...`);
      await fileInput.setInputFiles({
        name: filename,
        mimeType: 'image/png',
        buffer: imageBuffer,
      });
      
      // Give React time to process the change event
      await this.page.waitForTimeout(100 * attempt);
      
      // Quick check if upload started
      const buttonText = await uploadButton.textContent();
      const currentCount = await this.photos.count();
      const isUploading = buttonText?.includes('Uploading') || buttonText?.includes('Nahrávání') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;
      
      if (isUploading || hasNewPhoto) {
        uploadTriggered = true;
        console.log(`[GalleryPage] Upload triggered on attempt #${attempt} at T+${Date.now() - startTime}ms`);
      } else {
        console.log(`[GalleryPage] Attempt #${attempt}: button="${buttonText}", photos=${currentCount} - retrying...`);
        // Clear and retry
        if (attempt < 3) {
          await fileInput.setInputFiles([]);
          await this.page.waitForTimeout(50);
        }
      }
    }
    
    console.log(`[GalleryPage] Files set at T+${Date.now() - startTime}ms, waiting for upload to process...`);
    
    // CRITICAL: Give React time to process the change event and update state.
    // The setInputFiles() call returns immediately but React's event handler
    // runs asynchronously. Without this, we might start polling before
    // isUploading state is set, causing false negatives.
    await this.page.waitForTimeout(50);
    
    // First, wait for upload to start (button text changes to "Uploading" or shows percentage)
    // OR if upload is already complete (photo count increased)
    // Use expect().toPass() for robustness against DOM changes
    let pollCount = 0;
    await expect(async () => {
      pollCount++;
      const buttonText = await uploadButton.textContent();
      const currentCount = await this.photos.count();
      // Button shows "Uploading..." (EN), "Nahrávání..." (CS), or a percentage like "33%", "66%" during upload
      const isUploading = buttonText?.includes('Uploading') || buttonText?.includes('Nahrávání') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;
      
      // Log every poll to help debug timing issues
      if (pollCount <= 5 || pollCount % 10 === 0) {
        console.log(`[GalleryPage] Poll #${pollCount} at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}, uploading=${isUploading}, hasNew=${hasNewPhoto}`);
      }
      
      expect(isUploading || hasNewPhoto).toBe(true);
    }).toPass({ timeout: 30000, intervals: [100, 200, 500, 1000] });
    console.log(`[GalleryPage] Upload started or photo appeared at T+${Date.now() - startTime}ms (after ${pollCount} polls)`);
    
    // Now wait for upload to complete - button NOT showing "Uploading" or percentage AND photo count reached
    // Use expect().toPass() which is resilient to temporary DOM changes during sync
    let completePollCount = 0;
    await expect(async () => {
      completePollCount++;
      const buttonText = await uploadButton.textContent();
      // Button shows "Uploading..." (EN), "Nahrávání..." (CS), or a percentage like "33%", "66%" during upload
      const isUploading = buttonText?.includes('Uploading') || buttonText?.includes('Nahrávání') || /\d+%/.test(buttonText || '');
      const currentCount = await this.photos.count();
      
      // Log completion polls
      if (completePollCount <= 3 || completePollCount % 5 === 0) {
        console.log(`[GalleryPage] Complete poll #${completePollCount} at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}, uploading=${isUploading}`);
      }
      
      // Upload is complete when: not uploading AND photo count reached expected
      expect(isUploading).toBe(false);
      expect(currentCount).toBeGreaterThanOrEqual(expectedCount);
    }).toPass({ timeout: 60000, intervals: [200, 500, 1000, 2000] });
    
    const finalCount = await this.photos.count();
    console.log(`[GalleryPage] Upload complete at T+${Date.now() - startTime}ms. Final photo count: ${finalCount}`);
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
