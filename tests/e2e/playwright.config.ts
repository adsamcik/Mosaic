import { defineConfig, devices } from '@playwright/test';

/**
 * Chrome launch arguments for SharedArrayBuffer.
 * 
 * SharedArrayBuffer requires Cross-Origin-Isolation headers, but Chrome's
 * --enable-features=SharedArrayBuffer flag bypasses this for testing.
 * 
 * Note: crypto.subtle requires a secure context (HTTPS or localhost).
 * In CI, the docker-entrypoint.sh starts a socat proxy so tests access
 * the frontend via localhost, which browsers treat as inherently secure.
 */
const CHROME_ARGS = ['--enable-features=SharedArrayBuffer'];

/**
 * Playwright configuration for Mosaic E2E tests.
 *
 * Designed for parallel-safe execution on a single backend instance.
 *
 * ## Parallelization Strategy
 *
 * Tests are grouped by isolation requirements:
 * 
 * 1. **Read-only tests** (accessibility, app-load, animations)
 *    - Safe for maximum parallelization
 *    - No database mutations
 *
 * 2. **Isolated write tests** (most tests using testUser fixture)
 *    - Each test gets a unique user
 *    - Safe for full parallelization
 *
 * 3. **Pool user tests** (critical-flows using poolUser fixture)
 *    - Share state within a worker
 *    - Limited to 1 test per worker at a time
 *
 * 4. **Serial tests** (smoke)
 *    - Must run sequentially
 *    - Shared context between tests
 *
 * ## Test Categories
 *
 * Tests are organized with tags for selective execution:
 *
 * ### Priority Tags
 * - @p0: Critical path (must pass before release)
 * - @p1: Core features (should pass for stable release)
 * - @p2: Extended coverage (nice to have)
 *
 * ### Feature Tags
 * - @auth: Authentication (login, logout, session)
 * - @album: Album operations (create, rename, delete)
 * - @photo: Photo operations (upload, view, download)
 * - @sharing: Share links and collaboration
 * - @sync: Data synchronization
 * - @gallery: Gallery view and navigation
 * - @security: Security and error handling
 * - @a11y: Accessibility compliance
 * - @ui: UI interactions
 *
 * ### Speed Tags
 * - @fast: Quick tests (<10s)
 * - @slow: Slow tests (>30s)
 *
 * ### Special Tags
 * - @smoke: Minimal verification set
 * - @critical: End-to-end user journeys
 * - @multi-user: Requires multiple browser contexts
 * - @crypto: Involves encryption/decryption
 *
 * ## Running by Category
 *
 * ```bash
 * # Single category
 * npx playwright test --grep @smoke
 * npx playwright test --grep @auth
 *
 * # Multiple categories (OR)
 * npx playwright test --grep "@p0|@p1"
 *
 * # Exclude category
 * npx playwright test --grep-invert @slow
 *
 * # Combine with browser
 * npx playwright test --grep @smoke --project=chromium
 * ```
 *
 * @see README.md for full documentation
 * @see test-categories.ts for category definitions
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',

  // Run tests in parallel - each test is fully isolated via unique users
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry failed tests
  retries: process.env.CI ? 2 : 1,

  // Worker configuration for parallelism
  // We have 8 pool users, so we can scale up to 8 workers
  // Local: Use all 8 workers for maximum parallelism
  // CI: 4 workers for balance of speed vs stability
  workers: process.env.CI ? 4 : 8,

  // Fail fast in CI - stop after N failures to save resources
  maxFailures: process.env.CI ? 5 : undefined,

  // Reporter configuration
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'results/junit.xml' }],
    ['list'],
    // Add JSON reporter for programmatic access
    ['json', { outputFile: 'results/results.json' }],
    // GitHub Actions annotations for PR integration
    ...(process.env.CI ? [['github'] as const] : []),
  ],

  // Output directories
  outputDir: 'test-results',

  // Shared settings for all tests
  use: {
    // Base URL for the frontend
    baseURL: process.env.BASE_URL || 'http://localhost:5173',

    // Collect trace when retrying a failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',

    // Default timeout for actions
    actionTimeout: 15000,

    // Navigation timeout
    navigationTimeout: 30000,

    // Viewport size
    viewport: { width: 1280, height: 720 },

    // Ignore HTTPS errors (for local dev)
    ignoreHTTPSErrors: true,
  },

  // Global test timeout (generous for crypto operations)
  timeout: 90000,

  // Expect timeout for assertions
  expect: {
    timeout: 15000,
  },

  // Global setup - wait for backend health and seed user pool
  globalSetup: './global-setup.ts',

  // Global teardown - clean up test data
  globalTeardown: './global-teardown.ts',

  // Configure projects for major browsers
  projects: [
    // Fast smoke tests - runs only smoke.spec.ts with minimal overhead
    {
      name: 'smoke',
      testMatch: /smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: CHROME_ARGS,
        },
        // Faster settings for smoke tests
        trace: 'off',
        screenshot: 'off',
        video: 'off',
      },
      retries: 0, // No retries for smoke - fail fast
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Required for SharedArrayBuffer
        launchOptions: {
          args: CHROME_ARGS,
        },
      },
    },
    // Firefox has issues with WASM/libsodium crypto - hangs on registration/login
    // See investigation report in docs/specs/SPEC-FirefoxCryptoIssue.md
    // Root cause: Argon2id WASM performance is significantly slower in Firefox
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // WebKit has issues with SharedArrayBuffer, skip for now
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    // Mobile viewport tests
    // Note: Tests using poolUser fixture are excluded because pool users are
    // registered via chromium in global-setup, and mobile-chrome's Argon2 WASM
    // produces different key derivation, causing "Invalid username or password" errors.
    {
      name: 'mobile-chrome',
      testIgnore: [
        '**/critical-flows.spec.ts', // Uses poolUser fixture
      ],
      use: {
        ...devices['Pixel 5'],
        launchOptions: {
          args: CHROME_ARGS,
        },
      },
    },
  ],

  // Web server configuration for local development
  webServer: process.env.CI
    ? undefined
    : {
        command: 'cd ../../apps/admin && npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      },
});
