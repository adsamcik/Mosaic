/**
 * E2E Test Constants
 *
 * Single source of truth for all E2E test configuration constants.
 * All other files should import from here to avoid duplication.
 */

/**
 * Backend API URL
 */
export const API_URL = process.env.API_URL || 'http://localhost:5000';

/**
 * Frontend URL
 */
export const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

/**
 * Default test password for all test users
 */
export const TEST_PASSWORD = 'test-password-e2e-2024';

/**
 * Test constants for E2E tests
 * Single source of truth - all other files should import from here
 */
export const TEST_CONSTANTS = {
  PASSWORD: TEST_PASSWORD,
  WRONG_PASSWORD: 'wrong-password-12345',
  EMPTY_PASSWORD: '',
};
