/**
 * Global Setup for E2E Tests
 *
 * Runs once before all tests to ensure the environment is ready.
 */

const API_URL = process.env.API_URL || 'http://localhost:8080';
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
 * Clean up stale test data from previous runs
 * Only cleans data older than 24 hours to avoid affecting running tests
 */
async function cleanupStaleData(): Promise<void> {
  console.log('[Global Setup] Cleanup: Skipping (handled per-test)');
  // In a production setup, you might want to call a cleanup endpoint here
  // For now, each test handles its own cleanup
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
  await verifyEndpoints();
  await verifyCOOPCOEPHeaders();
  await cleanupStaleData();

  console.log('[Global Setup] Complete!');
}

export default globalSetup;
