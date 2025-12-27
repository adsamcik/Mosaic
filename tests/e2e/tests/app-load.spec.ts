/**
 * App Load Tests
 *
 * Basic tests to verify the application loads correctly.
 * Phase 1: Fixed assertions and improved error handling.
 */

import { test, expect } from '../fixtures';

test.describe('App Loading', () => {
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
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('loads static assets without critical errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Give time for any deferred loading
    await page.waitForTimeout(2000);

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
    await page.waitForLoadState('networkidle');

    // Should have title element
    const title = page.locator('h1');
    await expect(title.first()).toBeVisible();

    // Should have a form or input
    const passwordInput = page.getByLabel('Password');
    await expect(passwordInput).toBeVisible({ timeout: 30000 });
  });
});
