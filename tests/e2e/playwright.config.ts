import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Mosaic E2E tests.
 *
 * Designed for parallel-safe execution on a single backend instance.
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',

  // Run tests in parallel - each test is fully isolated
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry failed tests
  retries: process.env.CI ? 2 : 1,

  // Worker configuration for parallelism
  // Local: 4 workers for fast feedback
  // CI: 2 workers for stability
  workers: process.env.CI ? 2 : 4,

  // Reporter configuration
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'results/junit.xml' }],
    ['list'],
    // Add JSON reporter for programmatic access
    ['json', { outputFile: 'results/results.json' }],
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

  // Global setup - wait for backend health
  globalSetup: './global-setup.ts',

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Required for SharedArrayBuffer
        launchOptions: {
          args: ['--enable-features=SharedArrayBuffer'],
        },
      },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    // WebKit has issues with SharedArrayBuffer, skip for now
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    // Mobile viewport tests
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
        launchOptions: {
          args: ['--enable-features=SharedArrayBuffer'],
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
