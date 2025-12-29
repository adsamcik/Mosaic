/**
 * Tiered Timeout Constants
 *
 * Centralized timeout values for E2E tests, organized by operation type.
 * Using tiered timeouts improves test reliability by matching timeouts
 * to the expected duration of operations.
 *
 * @see docs/specs/SPEC-E2EFramework.md for design rationale
 */

/**
 * UI-related timeouts for element visibility, animations, and simple interactions.
 * These are short timeouts for operations that should complete quickly.
 */
export const UI_TIMEOUT = {
  /** Default timeout for element visibility (5s) */
  VISIBLE: 5000,
  /** Timeout for element to become hidden (5s) */
  HIDDEN: 5000,
  /** Timeout for animations to complete (1s) */
  ANIMATION: 1000,
  /** Timeout for user input actions (2s) */
  INPUT: 2000,
  /** Timeout for dialogs to open/close (10s) */
  DIALOG: 10000,
  /** Timeout for tooltips and hover states (3s) */
  HOVER: 3000,
} as const;

/**
 * Network-related timeouts for API calls and data loading.
 * These are medium timeouts for operations that involve network requests.
 */
export const NETWORK_TIMEOUT = {
  /** Default API request timeout (15s) */
  API: 15000,
  /** Timeout for page navigation (30s) */
  NAVIGATION: 30000,
  /** Timeout for form submissions (15s) */
  FORM_SUBMIT: 15000,
  /** Timeout for list/table data loading (20s) */
  DATA_LOAD: 20000,
  /** Timeout for file uploads (small files) (30s) */
  UPLOAD_SMALL: 30000,
  /** Timeout for file uploads (large files) (60s) */
  UPLOAD_LARGE: 60000,
} as const;

/**
 * Cryptography-related timeouts for encryption, decryption, and key operations.
 * These are longer timeouts for CPU-intensive operations that may vary by hardware.
 */
export const CRYPTO_TIMEOUT = {
  /** Default crypto operation timeout (30s) */
  DEFAULT: 30000,
  /** Timeout for key derivation (Argon2id) (45s) */
  KEY_DERIVATION: 45000,
  /** Timeout for login with key derivation (60s) */
  LOGIN: 60000,
  /** Timeout for photo encryption (per photo) (30s) */
  PHOTO_ENCRYPT: 30000,
  /** Timeout for photo decryption (per photo) (30s) */
  PHOTO_DECRYPT: 30000,
  /** Timeout for batch crypto operations (120s) */
  BATCH: 120000,
  /** Timeout for key rotation (60s) */
  KEY_ROTATION: 60000,
} as const;

/**
 * Test infrastructure timeouts for setup, teardown, and assertions.
 */
export const TEST_TIMEOUT = {
  /** Timeout for test hooks (beforeEach, afterEach) (30s) */
  HOOK: 30000,
  /** Timeout for test cleanup (15s) */
  CLEANUP: 15000,
  /** Timeout for retrying flaky assertions (10s) */
  RETRY: 10000,
  /** Maximum timeout for any single test (2 min) */
  MAX_TEST: 120000,
} as const;

/**
 * Combined timeout categories for convenience
 */
export const TIMEOUT = {
  ui: UI_TIMEOUT,
  network: NETWORK_TIMEOUT,
  crypto: CRYPTO_TIMEOUT,
  test: TEST_TIMEOUT,
} as const;

/**
 * Helper function to get appropriate timeout for an operation type
 */
export function getTimeout(
  category: 'ui' | 'network' | 'crypto' | 'test',
  operation: string
): number {
  const timeouts = TIMEOUT[category];
  if (operation in timeouts) {
    return timeouts[operation as keyof typeof timeouts];
  }
  // Return a sensible default based on category
  switch (category) {
    case 'ui':
      return UI_TIMEOUT.VISIBLE;
    case 'network':
      return NETWORK_TIMEOUT.API;
    case 'crypto':
      return CRYPTO_TIMEOUT.DEFAULT;
    case 'test':
      return TEST_TIMEOUT.HOOK;
    default:
      return 30000;
  }
}
