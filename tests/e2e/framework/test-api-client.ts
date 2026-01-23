/**
 * Test API Client
 *
 * Client for managing test users without browser automation.
 * Bypasses browser-based registration/login flow to avoid Argon2 parameter mismatches.
 */

import { type Page, type BrowserContext, type ConsoleMessage, type Request, type Response } from '@playwright/test';
import { execSync } from 'child_process';
import { API_URL, BASE_URL } from './constants';

/**
 * Log capture types (internal, not exported)
 */
interface CapturedLog {
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
 * Response from create-authenticated-user API
 */
export interface CreateAuthenticatedUserResponse {
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
