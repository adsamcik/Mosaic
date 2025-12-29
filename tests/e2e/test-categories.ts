/**
 * E2E Test Categories
 *
 * This file defines the test categories used to organize and filter E2E tests.
 * Categories allow running specific subsets of tests for faster feedback loops.
 *
 * Usage:
 *   npx playwright test --grep @smoke        # Run smoke tests only
 *   npx playwright test --grep @auth         # Run auth tests only
 *   npx playwright test --grep "@p0|@p1"     # Run P0 and P1 tests
 *   npx playwright test --grep-invert @slow  # Skip slow tests
 *
 * @see README.md for full documentation
 */

/**
 * Test Priority Categories
 *
 * These define the criticality level of tests:
 * - @p0: Critical path - must pass before any release
 * - @p1: Core features - should pass for stable release
 * - @p2: Extended coverage - nice to have passing
 */
export const PRIORITY = {
  P0: '@p0',
  P1: '@p1',
  P2: '@p2',
} as const;

/**
 * Feature Categories
 *
 * These group tests by feature area:
 */
export const FEATURE = {
  /** Authentication: login, logout, session management */
  AUTH: '@auth',

  /** Album operations: create, rename, delete, settings */
  ALBUM: '@album',

  /** Photo operations: upload, view, download, delete */
  PHOTO: '@photo',

  /** Sharing: share links, collaboration, member management */
  SHARING: '@sharing',

  /** Sync: data synchronization, offline, multi-session */
  SYNC: '@sync',

  /** Gallery: grid view, lightbox, selection, navigation */
  GALLERY: '@gallery',

  /** Security: error handling, validation, boundaries */
  SECURITY: '@security',

  /** Accessibility: WCAG compliance, keyboard navigation */
  A11Y: '@a11y',

  /** UI: interactions, responsiveness, theming */
  UI: '@ui',
} as const;

/**
 * Speed Categories
 *
 * These allow filtering by expected test duration:
 */
export const SPEED = {
  /** Quick tests (<10s) - good for rapid feedback */
  FAST: '@fast',

  /** Medium tests (10-30s) - typical feature tests */
  MEDIUM: '@medium',

  /** Slow tests (>30s) - comprehensive workflows */
  SLOW: '@slow',
} as const;

/**
 * Special Categories
 */
export const SPECIAL = {
  /** Smoke tests - minimal set to verify app is working */
  SMOKE: '@smoke',

  /** Critical flows - end-to-end user journeys */
  CRITICAL: '@critical',

  /** Flaky tests - known to be unreliable */
  FLAKY: '@flaky',

  /** Multi-user tests - require multiple browser contexts */
  MULTI_USER: '@multi-user',

  /** Crypto tests - involve encryption/decryption */
  CRYPTO: '@crypto',
} as const;

/**
 * All category tags for reference
 */
export const ALL_TAGS = {
  ...PRIORITY,
  ...FEATURE,
  ...SPEED,
  ...SPECIAL,
} as const;

/**
 * Common tag combinations for convenience
 */
export const PRESETS = {
  /** Run before every commit */
  PRE_COMMIT: '@smoke|@p0',

  /** Run in CI pipeline */
  CI: '@p0|@p1',

  /** Quick local testing */
  QUICK: '@fast|@smoke',

  /** Full regression */
  FULL: '@p0|@p1|@p2',
} as const;
