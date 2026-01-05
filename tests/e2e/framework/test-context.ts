/**
 * Test Context Module
 *
 * Provides complete test isolation for parallel E2E test execution.
 * Each test gets its own unique context with isolated users and resources.
 */

import { type Page, type BrowserContext, type Browser } from '@playwright/test';

/**
 * Unique test identifier for complete isolation
 * Uses crypto.randomUUID() for collision-proof IDs even in parallel execution
 */
export function generateTestId(workerIndex: number): string {
  const timestamp = Date.now().toString(36);
  // Use crypto.randomUUID for strong uniqueness (available in Node 14.17+)
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `w${workerIndex}-${timestamp}-${uuid}`;
}

/**
 * Generate a user email that is unique to this test run
 */
export function generateUserEmail(testId: string, name: string): string {
  return `test-${testId}-${name}@e2e.local`;
}

/**
 * Tracked resource for cleanup
 */
interface TrackedResource {
  type: 'album' | 'user' | 'share-link';
  id: string;
  owner?: string;
}

/**
 * Authenticated user with their page and context
 */
export interface AuthenticatedUser {
  email: string;
  page: Page;
  context: BrowserContext;
  userId?: string;
}

/**
 * Test Context for complete test isolation
 *
 * Usage:
 * ```typescript
 * const ctx = new TestContext(browser, workerIndex);
 * const alice = await ctx.createAuthenticatedUser('alice');
 * const bob = await ctx.createAuthenticatedUser('bob');
 *
 * // ... test code ...
 *
 * await ctx.cleanup(); // Cleans up all resources
 * ```
 */
export class TestContext {
  readonly testId: string;
  private users: Map<string, AuthenticatedUser> = new Map();
  private resources: TrackedResource[] = [];
  private apiBaseUrl: string;

  constructor(
    private browser: Browser,
    workerIndex: number,
    apiBaseUrl: string = process.env.API_URL || 'http://localhost:5000'
  ) {
    this.testId = generateTestId(workerIndex);
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Create an authenticated user with their own browser context
   * The user will have Remote-User header injected for all API calls
   */
  async createAuthenticatedUser(name: string): Promise<AuthenticatedUser> {
    const email = generateUserEmail(this.testId, name);

    // Check if user already exists
    if (this.users.has(name)) {
      return this.users.get(name)!;
    }

    // Create new browser context
    const context = await this.browser.newContext();
    const page = await context.newPage();

    // Inject auth header for all API calls
    await page.route('**/api/**', async (route) => {
      const headers = {
        ...route.request().headers(),
        'Remote-User': email,
      };
      await route.continue({ headers });
    });

    const user: AuthenticatedUser = {
      email,
      page,
      context,
    };

    this.users.set(name, user);
    this.trackResource('user', email);

    return user;
  }

  /**
   * Get an existing user by name
   */
  getUser(name: string): AuthenticatedUser | undefined {
    return this.users.get(name);
  }

  /**
   * Track a resource for cleanup
   */
  trackResource(type: TrackedResource['type'], id: string, owner?: string): void {
    this.resources.push({ type, id, owner });
  }

  /**
   * Track an album for cleanup
   */
  trackAlbum(albumId: string, ownerEmail: string): void {
    this.trackResource('album', albumId, ownerEmail);
  }

  /**
   * Generate a unique album name for this test
   */
  generateAlbumName(baseName: string = 'Test Album'): string {
    return `${baseName} ${this.testId}`;
  }

  /**
   * Generate a unique photo filename for this test
   */
  generatePhotoName(index: number = 1): string {
    return `photo-${this.testId}-${index.toString().padStart(3, '0')}.png`;
  }

  /**
   * Clean up all resources created during the test
   */
  async cleanup(): Promise<void> {
    const errors: Error[] = [];

    // Clean up albums first (they depend on users)
    for (const resource of this.resources.filter((r) => r.type === 'album')) {
      try {
        await this.deleteAlbumViaAPI(resource.id, resource.owner!);
      } catch (error) {
        // Log but continue cleanup
        errors.push(error as Error);
      }
    }

    // Close all browser contexts
    for (const user of this.users.values()) {
      try {
        await user.context.close();
      } catch (error) {
        errors.push(error as Error);
      }
    }

    this.users.clear();
    this.resources = [];

    if (errors.length > 0) {
      console.warn(`[TestContext] Cleanup had ${errors.length} errors:`, errors);
    }
  }

  /**
   * Delete an album via API with timeout to prevent fixture teardown hangs
   */
  private async deleteAlbumViaAPI(albumId: string, userEmail: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/albums/${albumId}`, {
        method: 'DELETE',
        headers: {
          'Remote-User': userEmail,
        },
        signal: controller.signal,
      });

      // 404 is OK - album might already be deleted
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete album ${albumId}: ${response.status}`);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.warn(`[TestContext] Cleanup timeout for album ${albumId}`);
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Test Context for two-user collaboration scenarios
 */
export interface CollaborationContext {
  testId: string;
  alice: AuthenticatedUser;
  bob: AuthenticatedUser;
  cleanup: () => Promise<void>;
  trackAlbum: (albumId: string, ownerEmail: string) => void;
  generateAlbumName: (baseName?: string) => string;
}

/**
 * Create a collaboration context with two users
 */
export async function createCollaborationContext(
  browser: Browser,
  workerIndex: number
): Promise<CollaborationContext> {
  const ctx = new TestContext(browser, workerIndex);

  const alice = await ctx.createAuthenticatedUser('alice');
  const bob = await ctx.createAuthenticatedUser('bob');

  return {
    testId: ctx.testId,
    alice,
    bob,
    cleanup: () => ctx.cleanup(),
    trackAlbum: (albumId, ownerEmail) => ctx.trackAlbum(albumId, ownerEmail),
    generateAlbumName: (baseName) => ctx.generateAlbumName(baseName),
  };
}
