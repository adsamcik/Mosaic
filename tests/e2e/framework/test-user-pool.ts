/**
 * Test User Pool
 *
 * Manages pre-seeded pool users and custom user creation for E2E tests.
 *
 * Pool users are pre-seeded in the database and should be used for read-only
 * tests that don't modify user state. For tests that need to modify user data
 * (e.g., changing settings, deleting resources), use createCustomUser() to
 * get a fresh, isolated user.
 */

import { TEST_PASSWORD } from './test-data-factory';

/**
 * API URL for backend requests
 */
const API_URL = process.env.API_URL || 'http://localhost:8080';

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
 * Pre-seeded pool users for each authentication mode
 * These users are created during test environment setup and should
 * be used for tests that don't modify user state.
 */
export const POOL_USERS = {
  proxy: {
    email: 'pool-proxy@e2e.local',
    authMode: 'proxy' as const,
    password: TEST_PASSWORD,
  },
  local: {
    email: 'pool-local@e2e.local',
    authMode: 'local' as const,
    password: TEST_PASSWORD,
  },
} as const;

/**
 * Get the pre-seeded pool user for an auth mode
 *
 * @param authMode - The authentication mode ('proxy' or 'local')
 * @returns The pool user for the specified auth mode
 *
 * @example
 * ```typescript
 * const user = getPoolUser('proxy');
 * // Use user.email for Remote-User header
 * ```
 */
export function getPoolUser(authMode: AuthMode): PoolUser {
  return POOL_USERS[authMode];
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
  return email === POOL_USERS.proxy.email || email === POOL_USERS.local.email;
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
