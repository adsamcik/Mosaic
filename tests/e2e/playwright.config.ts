import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Mosaic E2E tests.
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  
  // Run tests in parallel
  fullyParallel: true,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Limit workers on CI for stability
  workers: process.env.CI ? 2 : undefined,
  
  // Reporter configuration
  reporter: [
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'results/junit.xml' }],
    ['list'],
  ],
  
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
    actionTimeout: 10000,
  },
  
  // Global timeout
  timeout: 60000,
  
  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
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
      use: { ...devices['Pixel 5'] },
    },
  ],
  
  // Web server configuration for local development
  webServer: process.env.CI ? undefined : {
    command: 'cd ../../apps/admin && npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
