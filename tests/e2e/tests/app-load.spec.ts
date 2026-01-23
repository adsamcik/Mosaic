/**
 * App Load Tests
 *
 * Basic tests to verify the application loads correctly.
 * Phase 1: Fixed assertions and improved error handling.
 */

import { expect, test, LoginPage } from '../fixtures';

test.describe('App Loading @p1 @fast', () => {
  test('loads the application and shows login form', async ({ page }) => {
    await page.goto('/');

    // Should show login form initially
    const loginForm = page.getByTestId('login-form');
    await expect(loginForm).toBeVisible({ timeout: 30000 });
  });

  test('has correct security headers for SharedArrayBuffer', async ({ page }) => {
    const response = await page.goto('/');

    expect(response).not.toBeNull();
    const headers = response!.headers();

    // Check COOP/COEP headers required for SharedArrayBuffer
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    // 'credentialless' is a valid alternative to 'require-corp' that enables SharedArrayBuffer
    // while allowing cross-origin resources that don't require credentials
    expect(headers['cross-origin-embedder-policy']).toBe('credentialless');
  });

  test('loads static assets without critical errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Wait for deferred loading by ensuring no new errors appear for a stable period
    let lastErrorCount = errors.length;
    await expect(async () => {
      // If error count stabilizes (no new errors for this check), we're done
      const currentCount = errors.length;
      const isStable = currentCount === lastErrorCount;
      lastErrorCount = currentCount;
      expect(isStable).toBe(true);
    }).toPass({ timeout: 5000, intervals: [500, 500, 500, 500, 500] });

    // Filter out expected errors (e.g., API not available in some test modes)
    const criticalErrors = errors.filter(
      (e) => !e.includes('Failed to fetch') && 
             !e.includes('NetworkError') &&
             !e.includes('net::ERR')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('is responsive on mobile viewport', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // Should still render login form correctly
    const loginForm = page.getByTestId('login-form');
    await expect(loginForm).toBeVisible({ timeout: 30000 });
  });

  test('renders main elements correctly', async ({ page }) => {
    await page.goto('/');

    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');

    // Should have title element
    const title = page.locator('h1');
    await expect(title.first()).toBeVisible();

    // Should have a form or input (use i18n-compatible locator)
    const loginPage = new LoginPage(page);
    await expect(loginPage.passwordInput).toBeVisible({ timeout: 30000 });
  });
});
