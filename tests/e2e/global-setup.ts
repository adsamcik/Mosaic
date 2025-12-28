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
 * Global setup function
 */
async function globalSetup(): Promise<void> {
  console.log('[Global Setup] Starting...');
  console.log(`[Global Setup] API_URL: ${API_URL}`);
  console.log(`[Global Setup] BASE_URL: ${process.env.BASE_URL || 'http://localhost:5173'}`);

  await waitForBackend();
  await verifyEndpoints();
  await cleanupStaleData();

  console.log('[Global Setup] Complete!');
}

export default globalSetup;
