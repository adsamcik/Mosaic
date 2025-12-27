/**
 * Test fixtures and page object models for Mosaic E2E tests.
 */

import { test as base, expect, type Page } from '@playwright/test';

/**
 * API URL for backend requests
 */
const API_URL = process.env.API_URL || 'http://localhost:8080';

/**
 * Extended test fixtures
 */
export const test = base.extend<{
  authenticatedPage: Page;
  testUser: string;
}>({
  /**
   * Generate a unique test user for each test
   */
  testUser: async ({}, use) => {
    const user = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    await use(user);
  },

  /**
   * Page with authentication headers set
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
});

export { expect };

/**
 * Page Object Model for the Login page
 */
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/');
  }

  async waitForLogin() {
    await this.page.waitForSelector('[data-testid="login-form"]', { timeout: 10000 });
  }

  get passwordInput() {
    return this.page.getByLabel('Password');
  }

  get loginButton() {
    return this.page.getByRole('button', { name: /log ?in/i });
  }

  async login(password: string) {
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}

/**
 * Page Object Model for the App Shell
 */
export class AppShell {
  constructor(private page: Page) {}

  async waitForLoad() {
    await this.page.waitForSelector('[data-testid="app-shell"]', { timeout: 30000 });
  }

  get albumList() {
    return this.page.getByTestId('album-list');
  }

  get createAlbumButton() {
    return this.page.getByRole('button', { name: /create album|new album/i });
  }

  get uploadButton() {
    return this.page.getByTestId('upload-button');
  }

  async createAlbum() {
    await this.createAlbumButton.click();
  }
}

/**
 * Page Object Model for Gallery view
 */
export class GalleryPage {
  constructor(private page: Page) {}

  async waitForLoad() {
    await this.page.waitForSelector('[data-testid="gallery"]', { timeout: 10000 });
  }

  get photoGrid() {
    return this.page.getByTestId('photo-grid');
  }

  get photos() {
    return this.page.getByTestId('photo-thumbnail');
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
      throw new Error(`Failed to create album: ${response.status}`);
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
}
