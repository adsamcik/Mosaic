/**
 * Test User Pool
 *
 * Manages pre-seeded pool users and custom user creation for E2E tests.
 *
 * Pool users are pre-seeded in the database and should be used for read-only
 * tests that don't modify user state. For tests that need to modify user data
 * (e.g., changing settings, deleting resources), use createCustomUser() to
 * get a fresh, isolated user.
 *
 * IMPORTANT: The authoritative POOL_USERS definition is in auth-setup.ts.
 * This module re-exports it and provides helper functions.
 */

import { API_URL, TEST_PASSWORD } from './constants';
import { POOL_USERS } from '../auth-setup';

// Re-export POOL_USERS from auth-setup.ts (single source of truth)
export { POOL_USERS };

/**
 * Authentication mode for users
 */
export type AuthMode = 'proxy' | 'local';

/**
 * Represents a user in the test pool
 */
export interface PoolUser {
  email: string;
  authMode: AuthMode;
  password: string; // Always TEST_PASSWORD for pool users
}

/**
 * Get a pool user by index.
 *
 * Pool users are local auth users (pool-local-1 through pool-local-8).
 * Use workerIndex to get a unique user per parallel worker.
 *
 * @param index - The index (usually workerIndex % POOL_USERS.length)
 * @returns The pool user at that index
 *
 * @example
 * ```typescript
 * const user = getPoolUserByIndex(workerIndex);
 * ```
 */
export function getPoolUserByIndex(index: number): PoolUser {
  const poolUser = POOL_USERS[index % POOL_USERS.length];
  return {
    email: poolUser.username,
    authMode: 'local',
    password: TEST_PASSWORD,
  };
}

/**
 * Check if an email belongs to a pool user
 *
 * @param email - The email to check
 * @returns true if the email is a pool user
 *
 * @example
 * ```typescript
 * if (isPoolUser(email)) {
 *   // Don't delete this user's data - it's shared!
 * }
 * ```
 */
export function isPoolUser(email: string): boolean {
  return POOL_USERS.some(user => user.username === email);
}

/**
 * Create a custom user via the test seed API
 *
 * Use this for tests that need to modify user state. Each custom user
 * is isolated and can be safely modified or deleted.
 *
 * @param name - A descriptive name for the user (used in email generation)
 * @param authMode - The authentication mode (default: 'proxy')
 * @returns A promise resolving to the created PoolUser
 * @throws Error if user creation fails
 *
 * @example
 * ```typescript
 * const user = await createCustomUser('album-owner', 'proxy');
 * // user.email is unique and isolated for this test
 * ```
 */
export async function createCustomUser(
  name: string,
  authMode: AuthMode = 'proxy'
): Promise<PoolUser> {
  const email = `custom-${name}-${Date.now()}@e2e.local`;

  const response = await fetch(`${API_URL}/api/test-seed/create-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, authMode }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Failed to create custom user '${name}': ${response.status} - ${errorText}`
    );
  }

  return { email, authMode, password: TEST_PASSWORD };
}

/**
 * Generate a unique user email for dynamic creation
 *
 * Used when tests register users themselves (e.g., auth flow tests).
 * This does NOT create the user - it only generates a unique email.
 *
 * @param testId - The test ID for namespacing
 * @param name - A descriptive name for the user
 * @returns A unique email address
 *
 * @example
 * ```typescript
 * const email = generateDynamicUserEmail(ctx.testId, 'new-signup');
 * // Use in registration flow
 * await page.fill('[data-testid="email-input"]', email);
 * ```
 */
export function generateDynamicUserEmail(testId: string, name: string): string {
  return `dynamic-${testId}-${name}@e2e.local`;
}
