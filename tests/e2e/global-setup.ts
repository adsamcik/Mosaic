/**
 * Global Setup for E2E Tests
 *
 * Runs once before all tests to ensure the environment is ready.
 * This includes:
 * 1. Waiting for backend to be healthy
 * 2. Resetting test data from previous runs
 * 3. Pre-authenticating pool users for fast test execution
 */

import { setupPoolUsers, clearAuthStates } from './auth-setup';

const API_URL = process.env.API_URL || 'http://localhost:5000';
const MAX_WAIT_MS = 60000;
const POLL_INTERVAL_MS = 2000;

/**
 * Wait for backend to be healthy
 */
async function waitForBackend(): Promise<void> {
  console.log(`[Global Setup] Waiting for backend at ${API_URL}...`);
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const response = await fetch(`${API_URL}/health`);
      if (response.ok) {
        console.log('[Global Setup] Backend is healthy!');
        return;
      }
    } catch {
      // Backend not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Backend did not become healthy within ${MAX_WAIT_MS}ms`);
}

/**
 * Verify critical API endpoints are accessible
 */
async function verifyEndpoints(): Promise<void> {
  console.log('[Global Setup] Verifying critical endpoints...');

  const endpoints = ['/api/albums', '/api/users/me'];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        headers: {
          'Remote-User': 'global-setup-test@e2e.local',
        },
      });

      // 200, 401, or 404 are acceptable - means endpoint exists
      if (response.status >= 500) {
        throw new Error(`Endpoint ${endpoint} returned ${response.status}`);
      }

      console.log(`[Global Setup] ${endpoint}: ${response.status} OK`);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Cannot reach ${endpoint}: ${error.message}`);
      }
      throw error;
    }
  }

  console.log('[Global Setup] All endpoints verified!');
}

/**
 * Reset test data from previous runs
 * Calls the test-seed reset endpoint to clean up test users
 */
async function resetTestData(): Promise<void> {
  console.log('[Global Setup] Resetting test data...');
  try {
    const response = await fetch(`${API_URL}/api/test-seed/reset`, { method: 'POST' });
    if (!response.ok) {
      // Log warning but don't fail - endpoint might not exist in non-test builds
      console.warn(`[Global Setup] Reset endpoint returned ${response.status}`);
      return;
    }
    const result = (await response.json()) as { deletedUsers: number };
    console.log(`[Global Setup] Deleted ${result.deletedUsers} test users`);
  } catch (error) {
    console.warn(`[Global Setup] Reset failed: ${error}`);
    // Don't fail - endpoint might not exist
  }
}

/**
 * Seed the user pool for parallel test execution
 * Ensures pool users are available for tests
 */
async function seedUserPool(): Promise<void> {
  console.log('[Global Setup] Seeding user pool...');
  try {
    const response = await fetch(`${API_URL}/api/test-seed/ensure-pool`, { method: 'POST' });
    if (!response.ok) {
      console.warn(`[Global Setup] Seed pool endpoint returned ${response.status}`);
      return;
    }
    const result = (await response.json()) as { users: string[] };
    console.log(`[Global Setup] Pool users: ${result.users.join(', ')}`);
  } catch (error) {
    console.warn(`[Global Setup] Seed pool failed: ${error}`);
    // Don't fail - tests may use on-demand user creation
  }
}

/**
 * Verify COOP/COEP headers are set correctly for SharedArrayBuffer support
 * These headers are required for the crypto/WASM workers to function
 */
async function verifyCOOPCOEPHeaders(): Promise<void> {
  const FRONTEND_URL = process.env.BASE_URL || 'http://localhost:5173';
  console.log(`[Global Setup] Verifying COOP/COEP headers at ${FRONTEND_URL}...`);

  try {
    const response = await fetch(FRONTEND_URL);
    const coop = response.headers.get('cross-origin-opener-policy');
    const coep = response.headers.get('cross-origin-embedder-policy');

    if (coop !== 'same-origin') {
      console.warn(
        `[Global Setup] WARNING: Cross-Origin-Opener-Policy is '${coop}', expected 'same-origin'.`
      );
      console.warn('[Global Setup] SharedArrayBuffer may not work. Crypto operations may fail.');
    } else {
      console.log('[Global Setup] COOP: same-origin ✓');
    }

    if (coep !== 'require-corp' && coep !== 'credentialless') {
      console.warn(
        `[Global Setup] WARNING: Cross-Origin-Embedder-Policy is '${coep}', expected 'require-corp' or 'credentialless'.`
      );
      console.warn('[Global Setup] SharedArrayBuffer may not work. Crypto operations may fail.');
    } else {
      console.log(`[Global Setup] COEP: ${coep} ✓`);
    }
  } catch (error) {
    console.warn(`[Global Setup] Could not verify headers: ${error}`);
    // Don't fail - Vite dev server might not be running yet
  }
}

/**
 * Global setup function
 */
async function globalSetup(): Promise<void> {
  console.log('[Global Setup] Starting...');
  console.log(`[Global Setup] API_URL: ${API_URL}`);
  console.log(`[Global Setup] BASE_URL: ${process.env.BASE_URL || 'http://localhost:5173'}`);

  await waitForBackend();
  await resetTestData();
  
  // Clear old auth states before creating new ones
  clearAuthStates();
  
  await seedUserPool();
  await verifyEndpoints();
  await verifyCOOPCOEPHeaders();
  
  // Pre-authenticate pool users (saves browser state for fast test startup)
  // This is optional - the poolUser fixture will register/login fresh if needed
  console.log('[Global Setup] Pre-authenticating pool users (optional, 30s timeout)...');
  try {
    await Promise.race([
      setupPoolUsers(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Auth setup timeout')), 30000))
    ]);
  } catch (error) {
    console.warn(`[Global Setup] Auth setup skipped: ${error instanceof Error ? error.message : error}`);
    console.log('[Global Setup] Tests will register/login pool users on demand');
  }

  console.log('[Global Setup] Complete!');
}

export default globalSetup;
