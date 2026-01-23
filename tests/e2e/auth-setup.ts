/**
 * Pre-authenticate test users for E2E tests.
 * 
 * This script uses Playwright to complete the full login flow (including crypto initialization)
 * for a set of pool users, then saves their browser state to disk.
 * 
 * Tests can then load this state instead of going through the registration flow each time,
 * making tests faster and more reliable.
 */

import { chromium, type Browser, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { BASE_URL, TEST_PASSWORD } from './framework/constants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Directory to store auth state files
 */
export const AUTH_STATE_DIR = path.join(__dirname, '.auth-states');

/**
 * Pool users that will be pre-authenticated.
 * 
 * We have 8 pool users to support up to 8 parallel workers without collision.
 * Each worker gets a unique user via workerIndex % POOL_USERS.length.
 */
export const POOL_USERS = [
  { username: 'pool-local-1@e2e.local', stateFile: 'pool-local-1.json' },
  { username: 'pool-local-2@e2e.local', stateFile: 'pool-local-2.json' },
  { username: 'pool-local-3@e2e.local', stateFile: 'pool-local-3.json' },
  { username: 'pool-local-4@e2e.local', stateFile: 'pool-local-4.json' },
  { username: 'pool-local-5@e2e.local', stateFile: 'pool-local-5.json' },
  { username: 'pool-local-6@e2e.local', stateFile: 'pool-local-6.json' },
  { username: 'pool-local-7@e2e.local', stateFile: 'pool-local-7.json' },
  { username: 'pool-local-8@e2e.local', stateFile: 'pool-local-8.json' },
] as const;

/**
 * Get the path to a user's auth state file
 */
export function getAuthStatePath(stateFile: string): string {
  return path.join(AUTH_STATE_DIR, stateFile);
}

/**
 * Check if auth state exists for a user
 */
export function hasAuthState(stateFile: string): boolean {
  return fs.existsSync(getAuthStatePath(stateFile));
}

/**
 * Page Object for login page (minimal version for auth setup)
 */
class LoginPageSetup {
  constructor(private page: Page) {}

  get usernameInput() {
    return this.page.getByLabel(/username|uživatelské jméno/i);
  }

  get passwordInput() {
    return this.page.getByLabel(/^(Password|Heslo)$/i);
  }

  get confirmPasswordInput() {
    return this.page.getByLabel(/confirm password|potvrzení hesla/i);
  }

  get createAccountButton() {
    return this.page.getByRole('button', { name: /create account|vytvořit účet/i }).first();
  }

  get loginButton() {
    return this.page.getByRole('button', { name: /unlock|sign in|přihlásit se|odemknout/i });
  }

  get errorMessage() {
    return this.page.getByRole('alert');
  }

  get modeToggleToRegister() {
    return this.page.getByRole('button', { name: /don't have an account|nemáte účet/i });
  }

  get modeToggleToLogin() {
    return this.page.getByRole('button', { name: /already have an account|máte účet/i });
  }

  async waitForForm() {
    await this.page.getByTestId('login-form').waitFor({ state: 'visible', timeout: 30000 });
    await this.passwordInput.waitFor({ state: 'visible', timeout: 30000 });
  }

  async switchToRegisterMode() {
    const isInRegister = await this.confirmPasswordInput.isVisible().catch(() => false);
    if (!isInRegister) {
      await this.modeToggleToRegister.click();
      await this.confirmPasswordInput.waitFor({ state: 'visible', timeout: 10000 });
    }
  }

  async switchToLoginMode() {
    const isInLogin = !(await this.confirmPasswordInput.isVisible().catch(() => false));
    if (!isInLogin) {
      await this.modeToggleToLogin.click();
      await this.confirmPasswordInput.waitFor({ state: 'hidden', timeout: 10000 });
    }
  }

  async register(username: string, password: string): Promise<'success' | 'exists' | 'rate_limited' | 'error'> {
    await this.switchToRegisterMode();
    
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
    await this.createAccountButton.click();
    
    // Wait for either success or error
    const appShell = this.page.getByTestId('app-shell');
    const errorAlert = this.errorMessage;
    
    const result = await Promise.race([
      appShell.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'success' as const),
      errorAlert.waitFor({ state: 'visible', timeout: 60000 }).then(async () => {
        const text = await errorAlert.textContent();
        if (text?.toLowerCase().includes('already taken') || text?.toLowerCase().includes('already exists')) {
          return 'exists' as const;
        }
        if (text?.toLowerCase().includes('too many requests')) {
          return 'rate_limited' as const;
        }
        console.log(`[Auth Setup] Unknown error text: ${text}`);
        return 'error' as const;
      }),
    ]).catch(() => 'error' as const);
    
    return result;
  }

  async login(username: string, password: string): Promise<'success' | 'error'> {
    await this.switchToLoginMode();
    
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
    
    // Wait for success
    const appShell = this.page.getByTestId('app-shell');
    await appShell.waitFor({ state: 'visible', timeout: 60000 });
    return 'success';
  }
}

/**
 * Pre-authenticate a single user and save their state
 */
async function authenticateUser(
  browser: Browser,
  username: string,
  password: string,
  stateFile: string
): Promise<void> {
  console.log(`[Auth Setup] Authenticating ${username}...`);
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    await page.goto(BASE_URL);
    const loginPage = new LoginPageSetup(page);
    await loginPage.waitForForm();
    
    // Check if LocalAuth mode
    const isLocalAuth = await loginPage.usernameInput.isVisible({ timeout: 3000 }).catch(() => false);
    
    if (!isLocalAuth) {
      console.log(`[Auth Setup] ProxyAuth mode - skipping ${username} (headers-based auth)`);
      await context.close();
      return;
    }
    
    // Try to register first, with retry for rate limiting
    let registerResult = await loginPage.register(username, password);
    
    // Handle rate limiting with exponential backoff
    if (registerResult === 'rate_limited') {
      console.log(`[Auth Setup] Rate limited for ${username}, waiting 5s and retrying...`);
      // INTENTIONAL: Rate limit backoff requires real delay, not element wait
      await page.waitForTimeout(5000);
      // Reload and try login instead (user may have been created)
      await page.reload();
      await loginPage.waitForForm();
      registerResult = 'exists'; // Assume user exists, try login
    }
    
    if (registerResult === 'exists') {
      console.log(`[Auth Setup] User ${username} exists, logging in instead`);
      // User already exists, try to login
      await loginPage.login(username, password);
    } else if (registerResult === 'error') {
      throw new Error(`Failed to register ${username}`);
    }
    
    // Wait for app shell to confirm crypto is initialized
    await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 60000 });
    console.log(`[Auth Setup] ${username} authenticated, crypto initialized`);
    
    // Save the storage state
    const statePath = getAuthStatePath(stateFile);
    await context.storageState({ path: statePath });
    console.log(`[Auth Setup] Saved state to ${statePath}`);
    
  } finally {
    await context.close();
  }
}

/**
 * Pre-authenticate all pool users
 */
export async function setupPoolUsers(): Promise<void> {
  // Ensure auth state directory exists
  if (!fs.existsSync(AUTH_STATE_DIR)) {
    fs.mkdirSync(AUTH_STATE_DIR, { recursive: true });
  }
  
  const browser = await chromium.launch();
  
  try {
    for (let i = 0; i < POOL_USERS.length; i++) {
      const user = POOL_USERS[i];
      try {
        await authenticateUser(browser, user.username, TEST_PASSWORD, user.stateFile);
        
        // Small delay between users to avoid rate limiting
        // Only delay if there are more users to process
        if (i < POOL_USERS.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`[Auth Setup] Failed to authenticate ${user.username}:`, error);
        // Continue with other users
      }
    }
  } finally {
    await browser.close();
  }
}

/**
 * Clear all auth state files
 */
export function clearAuthStates(): void {
  if (fs.existsSync(AUTH_STATE_DIR)) {
    const files = fs.readdirSync(AUTH_STATE_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(AUTH_STATE_DIR, file));
    }
    console.log(`[Auth Setup] Cleared ${files.length} auth state files`);
  }
}

/**
 * Get a list of users that have valid auth state
 */
export function getAuthenticatedUsers(): typeof POOL_USERS[number][] {
  return POOL_USERS.filter(user => hasAuthState(user.stateFile));
}
