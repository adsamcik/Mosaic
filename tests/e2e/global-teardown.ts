/**
 * Global Teardown for E2E Tests
 *
 * Runs once after all tests complete to clean up test data.
 */

const API_URL = process.env.API_URL || 'http://localhost:8080';

/**
 * Reset test data after all tests complete
 * Cleans up test users and their associated data
 */
async function resetTestData(): Promise<void> {
  console.log('[Global Teardown] Resetting test data...');
  try {
    const response = await fetch(`${API_URL}/api/test-seed/reset`, { method: 'POST' });
    if (!response.ok) {
      // Log warning but don't fail - endpoint might not exist in non-test builds
      console.warn(`[Global Teardown] Reset endpoint returned ${response.status}`);
      return;
    }
    const result = (await response.json()) as { deletedUsers: number };
    console.log(`[Global Teardown] Deleted ${result.deletedUsers} test users`);
  } catch (error) {
    console.warn(`[Global Teardown] Reset failed: ${error}`);
    // Don't fail - endpoint might not exist
  }
}

/**
 * Global teardown function
 */
async function globalTeardown(): Promise<void> {
  console.log('[Global Teardown] Starting...');
  console.log(`[Global Teardown] API_URL: ${API_URL}`);

  await resetTestData();

  console.log('[Global Teardown] Complete!');
}

export default globalTeardown;
