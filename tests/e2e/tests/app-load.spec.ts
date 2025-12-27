/**
 * App Load Tests
 *
 * Basic tests to verify the application loads correctly.
 */

import { test, expect } from '../fixtures';

test.describe('App Loading', () => {
  test('loads the application', async ({ page }) => {
    await page.goto('/');

    // Should show either login form or app shell
    const loginForm = page.getByTestId('login-form');
    const appShell = page.getByTestId('app-shell');

    const hasLogin = await loginForm.isVisible().catch(() => false);
    const hasApp = await appShell.isVisible().catch(() => false);

    expect(hasLogin || hasApp).toBeTruthy();
  });

  test('has correct security headers', async ({ page }) => {
    const response = await page.goto('/');

    expect(response).not.toBeNull();
    const headers = response!.headers();

    // Check COOP/COEP headers required for SharedArrayBuffer
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('loads static assets', async ({ page }) => {
    await page.goto('/');

    // Wait for JavaScript to load
    await page.waitForLoadState('networkidle');

    // Check for console errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Give time for any deferred loading
    await page.waitForTimeout(2000);

    // Filter out expected errors (e.g., API not available in some test modes)
    const criticalErrors = errors.filter(
      (e) => !e.includes('Failed to fetch') && !e.includes('NetworkError')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('is responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // Should still render correctly
    const body = await page.locator('body');
    await expect(body).toBeVisible();
  });
});
