/**
 * Wait Utilities
 *
 * Reliable, condition-based wait patterns for E2E tests.
 * These replace arbitrary timeouts with deterministic waits.
 */

import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Wait options
 */
export interface WaitOptions {
  timeout?: number;
  interval?: number;
  message?: string;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_INTERVAL = 100;

/**
 * Wait for a condition to be true with polling
 *
 * @param condition - Async function that returns true when condition is met
 * @param options - Wait options
 */
export async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT, interval = DEFAULT_INTERVAL, message } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // Condition threw, keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(message || `Condition not met within ${timeout}ms`);
}

/**
 * Wait for an element to be visible and stable (no layout shifts)
 *
 * @param locator - Playwright locator
 * @param options - Wait options
 */
export async function waitForStable(
  locator: Locator,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT } = options;

  // First, wait for visibility
  await expect(locator).toBeVisible({ timeout });

  // Then wait for position to stabilize
  let lastBox = await locator.boundingBox();
  let stableCount = 0;
  const requiredStableFrames = 3;

  await waitForCondition(
    async () => {
      const currentBox = await locator.boundingBox();
      if (!currentBox || !lastBox) {
        lastBox = currentBox;
        stableCount = 0;
        return false;
      }

      const isStable =
        currentBox.x === lastBox.x &&
        currentBox.y === lastBox.y &&
        currentBox.width === lastBox.width &&
        currentBox.height === lastBox.height;

      if (isStable) {
        stableCount++;
      } else {
        stableCount = 0;
        lastBox = currentBox;
      }

      return stableCount >= requiredStableFrames;
    },
    { timeout, message: 'Element position did not stabilize' }
  );
}

/**
 * Wait for all network requests to complete
 *
 * @param page - Playwright page
 * @param options - Wait options with additional urlPattern
 */
export async function waitForNetworkIdle(
  page: Page,
  options: WaitOptions & { urlPattern?: string | RegExp } = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT, urlPattern } = options;

  let pendingRequests = 0;

  const requestHandler = (request: { url: () => string }) => {
    if (!urlPattern || request.url().match(urlPattern)) {
      pendingRequests++;
    }
  };

  const responseHandler = (response: { url: () => string }) => {
    if (!urlPattern || response.url().match(urlPattern)) {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  };

  const requestFailedHandler = (request: { url: () => string }) => {
    if (!urlPattern || request.url().match(urlPattern)) {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  };

  page.on('request', requestHandler);
  page.on('response', responseHandler);
  page.on('requestfailed', requestFailedHandler);

  try {
    await waitForCondition(
      () => pendingRequests === 0,
      { timeout, message: 'Network requests did not complete' }
    );
  } finally {
    page.removeListener('request', requestHandler);
    page.removeListener('response', responseHandler);
    page.removeListener('requestfailed', requestFailedHandler);
  }
}

/**
 * Wait for crypto worker to initialize
 * Checks for the app shell which indicates crypto is ready
 *
 * @param page - Playwright page
 * @param options - Wait options
 */
export async function waitForCryptoReady(
  page: Page,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = 60000 } = options;

  // The app shell only appears after crypto initialization
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout });
}

/**
 * Wait for page to be fully loaded and interactive
 *
 * @param page - Playwright page
 * @param options - Wait options
 */
export async function waitForPageReady(
  page: Page,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT } = options;

  // Wait for load state
  await page.waitForLoadState('networkidle', { timeout });

  // Wait for any loading spinners to disappear
  const spinner = page.locator('[data-testid="loading-spinner"], .loading, .spinner');
  const spinnerCount = await spinner.count();

  if (spinnerCount > 0) {
    await expect(spinner.first()).toBeHidden({ timeout });
  }
}

/**
 * Wait for toast/notification to appear and optionally disappear
 *
 * @param page - Playwright page
 * @param text - Expected toast text
 * @param options - Wait options with waitForDismiss flag
 */
export async function waitForToast(
  page: Page,
  text: string | RegExp,
  options: WaitOptions & { waitForDismiss?: boolean } = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT, waitForDismiss = false } = options;

  const toast = page.getByRole('alert').filter({ hasText: text });

  // Wait for toast to appear
  await expect(toast).toBeVisible({ timeout });

  if (waitForDismiss) {
    // Wait for toast to disappear
    await expect(toast).toBeHidden({ timeout });
  }
}

/**
 * Wait for upload to complete
 * Watches the upload button text and photo count
 *
 * @param page - Playwright page
 * @param expectedPhotoCount - Expected number of photos after upload
 * @param options - Wait options
 */
export async function waitForUploadComplete(
  page: Page,
  expectedPhotoCount?: number,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = 60000 } = options;

  // Wait for upload button to stop showing progress
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="upload-button"]');
      return btn && !btn.textContent?.includes('Uploading');
    },
    { timeout }
  );

  // If expected count provided, verify it
  if (expectedPhotoCount !== undefined) {
    const photos = page.locator(
      '[data-testid="photo-thumbnail"], [data-testid="justified-photo-thumbnail"]'
    );
    await expect(photos).toHaveCount(expectedPhotoCount, { timeout });
  }
}

/**
 * Wait for dialog to open
 *
 * @param page - Playwright page
 * @param testId - Test ID of the dialog
 * @param options - Wait options
 */
export async function waitForDialog(
  page: Page,
  testId: string,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT } = options;
  await expect(page.getByTestId(testId)).toBeVisible({ timeout });
}

/**
 * Wait for dialog to close
 *
 * @param page - Playwright page
 * @param testId - Test ID of the dialog
 * @param options - Wait options
 */
export async function waitForDialogClosed(
  page: Page,
  testId: string,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT } = options;
  await expect(page.getByTestId(testId)).toBeHidden({ timeout });
}

/**
 * Retry a function until it succeeds
 *
 * @param fn - Async function to retry
 * @param options - Retry options
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number; shouldRetry?: (error: Error) => boolean } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, shouldRetry = () => true } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxAttempts || !shouldRetry(lastError)) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
