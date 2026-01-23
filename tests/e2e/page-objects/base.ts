/**
 * Shared base utilities for page objects
 */

// Re-export Playwright types for convenience
export { type Page, type Locator, expect } from '@playwright/test';

// Re-export timeout constants
export { UI_TIMEOUT, NETWORK_TIMEOUT, CRYPTO_TIMEOUT } from '../framework/timeouts';

// Re-export TEST_PASSWORD from framework (single source of truth)
export { TEST_PASSWORD } from '../framework/test-data-factory';
