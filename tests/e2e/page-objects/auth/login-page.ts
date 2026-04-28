/**
 * Login Page Object
 *
 * Supports both LocalAuth and ProxyAuth modes:
 * - LocalAuth: username/password with registration option
 * - ProxyAuth: password-only (user identity from Remote-User header)
 */

import { type Page, type Locator, expect, TEST_PASSWORD, UI_TIMEOUT, NETWORK_TIMEOUT, CRYPTO_TIMEOUT } from '../base';

export class LoginPage {
  readonly page: Page;
  readonly form: Locator;
  readonly passwordInput: Locator;
  readonly usernameInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;
  readonly confirmPasswordInput: Locator;
  readonly createAccountButton: Locator;
  readonly modeToggleButton: Locator;
  readonly loginForm: Locator;

  constructor(page: Page) {
    this.page = page;
    this.form = page.getByTestId('login-form');
    this.loginForm = page.getByTestId('login-form');
    // Support both English and Czech labels
    this.passwordInput = page.getByLabel(/^(Password|Heslo)$/i);
    this.usernameInput = page.getByLabel(/username|uživatelské jméno/i);
    this.loginButton = page.getByRole('button', { name: /unlock|sign in|přihlásit se|odemknout/i });
    this.errorMessage = page.getByRole('alert');
    this.confirmPasswordInput = page.getByLabel(/confirm password|potvrzení hesla/i);
    this.createAccountButton = page.getByRole('button', { name: /create account|vytvořit účet/i }).first();
    this.modeToggleButton = page.getByRole('button', {
      name: /don't have an account|already have an account|nemáte účet|máte účet/i,
    });
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  async waitForForm(timeout = 60000): Promise<void> {
    // Wait for the form container to be visible
    await expect(this.form).toBeVisible({ timeout });
    
    // Wait for the form to finish loading (checkingAuthMode = false)
    // The password input only appears after auth mode is determined
    await expect(this.passwordInput).toBeVisible({ timeout });
  }

  /**
   * Login with password and optional username.
   * In LocalAuth mode: if username is provided, it will be filled.
   * In ProxyAuth mode: only password is used.
   * 
   * @param password - The password to enter
   * @param username - Optional username (for LocalAuth mode)
   */
  async login(password: string = TEST_PASSWORD, username?: string): Promise<void> {
    // Ensure we're in login mode, not register mode
    await this.switchToLoginMode();
    
    // Check if LocalAuth mode (username field visible) and username provided
    const isLocalAuth = await this.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth && username) {
      await this.usernameInput.clear();
      await this.usernameInput.fill(username);
    }
    
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  /**
   * Login with username and password (for LocalAuth mode).
   * If username field is not visible (ProxyAuth mode), only password is entered.
   */
  async loginWithUsername(username: string, password: string = TEST_PASSWORD): Promise<void> {
    // For LocalAuth mode with username field
    if (await this.usernameInput.isVisible().catch(() => false)) {
      await this.usernameInput.clear();
      await this.usernameInput.fill(username);
    }
    await this.passwordInput.clear();
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  /**
   * Login with auto-detection of auth mode.
   * If LocalAuth (username field visible) and username provided, fills username.
   * Otherwise just fills password.
   */
  async loginAuto(password: string = TEST_PASSWORD, username?: string): Promise<void> {
    // Check if LocalAuth mode (username field visible)
    const isLocalAuth = await this.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth && username) {
      await this.usernameInput.fill(username);
    }
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  async expectLoginSuccess(timeout = CRYPTO_TIMEOUT.BATCH): Promise<void> {
    await expect(this.page.getByTestId('app-shell')).toBeVisible({ timeout });
  }

  async unlockAfterReload(
    password: string = TEST_PASSWORD,
    username?: string,
    timeout = CRYPTO_TIMEOUT.BATCH,
  ): Promise<void> {
    await expect(async () => {
      const hasAppShell = await this.page
        .getByTestId('app-shell')
        .isVisible()
        .catch(() => false);
      const hasLoginForm = await this.form.isVisible().catch(() => false);
      expect(hasAppShell || hasLoginForm).toBe(true);
    }).toPass({ timeout, intervals: [100, 250, 500, 1000] });

    const appShell = this.page.getByTestId('app-shell');
    const hasAppShell = await appShell.isVisible().catch(() => false);
    if (hasAppShell) {
      const stayedUnlocked = await expect(async () => {
        await expect(appShell).toBeVisible({ timeout: 500 });
        expect(await this.form.isVisible().catch(() => false)).toBe(false);
      })
        .toPass({ timeout: 2000, intervals: [250, 500] })
        .then(() => true)
        .catch(() => false);

      if (!stayedUnlocked) {
        await expect(this.form).toBeVisible({ timeout });
      } else {
        return;
      }
    }

    const hasLoginForm = await this.form.isVisible().catch(() => false);
    if (!hasLoginForm) {
      await expect(this.form.or(appShell)).toBeVisible({ timeout });
    }

    if (await appShell.isVisible().catch(() => false)) {
      const stayedUnlocked = await expect(async () => {
        await expect(appShell).toBeVisible({ timeout: 500 });
        expect(await this.form.isVisible().catch(() => false)).toBe(false);
      })
        .toPass({ timeout: 2000, intervals: [250, 500] })
        .then(() => true)
        .catch(() => false);

      if (stayedUnlocked) {
        return;
      }
    }

    if (!(await this.form.isVisible().catch(() => false))) {
      await expect(this.form).toBeVisible({ timeout });
    }

    await this.waitForForm(timeout);
    const isLocalAuth = await this.usernameInput
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (isLocalAuth && username) {
      await this.loginWithUsername(username, password);
    } else {
      await this.login(password, username);
    }

    await this.expectLoginSuccess(timeout);
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: UI_TIMEOUT.DIALOG });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectFormVisible(): Promise<void> {
    await expect(this.form).toBeVisible({ timeout: NETWORK_TIMEOUT.NAVIGATION });
  }

  /**
   * Alias for expectFormVisible for backward compatibility
   */
  async expectLoginFormVisible(): Promise<void> {
    await this.expectFormVisible();
  }

  /**
   * Alias for expectError for backward compatibility
   */
  async expectErrorMessage(text?: string | RegExp): Promise<void> {
    await this.expectError(text);
  }

  /**
   * Switch to registration mode (LocalAuth only)
   * Only switches if not already in register mode.
   */
  async switchToRegisterMode(): Promise<void> {
    // Check if we're already in register mode by checking if confirm password field is visible
    const isAlreadyInRegisterMode = await this.confirmPasswordInput.isVisible().catch(() => false);
    if (isAlreadyInRegisterMode) {
      console.log('[LoginPage] Already in register mode, skipping switch');
      return;
    }
    
    const toggleBtn = this.page.getByRole('button', { name: /don't have an account|nemáte účet/i });
    // Wait for the toggle button to be visible with timeout
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });
    await toggleBtn.click();
    // Wait for registration form to appear
    await expect(this.confirmPasswordInput).toBeVisible({ timeout: 15000 });
  }

  /**
   * Switch to login mode (LocalAuth only)
   * Only switches if not already in login mode.
   */
  async switchToLoginMode(): Promise<void> {
    // Check if we're already in login mode by checking if confirm password field is hidden
    const isAlreadyInLoginMode = !(await this.confirmPasswordInput.isVisible().catch(() => false));
    if (isAlreadyInLoginMode) {
      console.log('[LoginPage] Already in login mode, skipping switch');
      return;
    }
    
    const toggleBtn = this.page.getByRole('button', { name: /already have an account|máte účet/i });
    // Wait for the toggle button to be visible with timeout
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });
    await toggleBtn.click();
    // Wait for the form to switch - confirm password field should disappear
    await expect(this.confirmPasswordInput).toBeHidden({ timeout: 5000 });
  }

  /**
   * Register a new user (LocalAuth mode)
   */
  async register(username: string, password: string): Promise<void> {
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
   * Smart login/register that handles both LocalAuth and ProxyAuth modes.
   * - In LocalAuth mode: attempts registration first, falls back to login if user exists
   * - In ProxyAuth mode: just enters the password
   * This is the recommended method for tests that need to complete login.
   */
  async loginOrRegister(password: string, username: string): Promise<void> {
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
        
        // Handle rate limiting - wait and retry
        if (errorText?.toLowerCase().includes('too many requests')) {
          console.log('[LoginPage] Rate limited, waiting 5s and retrying with login');
          // INTENTIONAL: Rate limit backoff requires real delay, not element wait
          await this.page.waitForTimeout(5000);
          // After rate limit, user may already exist, try login
          await this.switchToLoginMode();
          await this.usernameInput.clear();
          await this.usernameInput.fill(username);
          await this.passwordInput.fill(password);
          await expect(this.loginButton).toBeVisible({ timeout: 10000 });
          await this.loginButton.click();
        } else if (errorText?.toLowerCase().includes('already taken') || errorText?.toLowerCase().includes('already exists')) {
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
}
