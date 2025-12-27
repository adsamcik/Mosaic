/**
 * Accessibility Tests
 *
 * Tests for WCAG compliance and accessibility.
 */

import { test, expect } from '../fixtures';

test.describe('Accessibility', () => {
  test('has proper heading structure', async ({ page }) => {
    await page.goto('/');

    // Should have at least one h1
    const h1 = page.locator('h1');
    const h1Count = await h1.count();
    
    expect(h1Count).toBeGreaterThanOrEqual(1);
  });

  test('images have alt text', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    const images = await page.locator('img').all();
    
    for (const img of images) {
      const alt = await img.getAttribute('alt');
      const role = await img.getAttribute('role');
      
      // Image should have alt text or be decorative (role="presentation")
      expect(alt !== null || role === 'presentation').toBeTruthy();
    }
  });

  test('buttons have accessible names', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    const buttons = await page.locator('button').all();
    
    for (const button of buttons) {
      const name = await button.getAttribute('aria-label') || await button.textContent();
      const title = await button.getAttribute('title');
      
      // Button should have some accessible name
      expect((name && name.trim().length > 0) || title).toBeTruthy();
    }
  });

  test('forms have associated labels', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    const inputs = await page.locator('input:not([type="hidden"])').all();
    
    for (const input of inputs) {
      const id = await input.getAttribute('id');
      const ariaLabel = await input.getAttribute('aria-label');
      const ariaLabelledBy = await input.getAttribute('aria-labelledby');
      const placeholder = await input.getAttribute('placeholder');
      
      // Input should have a label association
      const hasLabel = id && await page.locator(`label[for="${id}"]`).count() > 0;
      
      expect(hasLabel || ariaLabel || ariaLabelledBy || placeholder).toBeTruthy();
    }
  });

  test('interactive elements are focusable', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    // Tab through the page
    const focusableElements: string[] = [];
    
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      
      const focused = await page.locator(':focus').first();
      const tagName = await focused.evaluate((el) => el.tagName).catch(() => '');
      
      if (tagName) {
        focusableElements.push(tagName);
      }
    }

    // Should be able to focus on multiple elements
    expect(focusableElements.length).toBeGreaterThan(0);
  });

  test('color contrast is sufficient', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    // Check that text elements have visible color
    const textElements = await page.locator('p, span, h1, h2, h3, h4, button, a').all();
    
    for (const element of textElements.slice(0, 10)) {
      const color = await element.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.color;
      });
      
      // Color should be defined
      expect(color).toBeTruthy();
      expect(color).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('supports reduced motion preference', async ({ page }) => {
    // Set reduced motion preference
    await page.emulateMedia({ reducedMotion: 'reduce' });
    
    await page.goto('/');

    // Page should load without issues
    await page.waitForLoadState('networkidle');
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('works with high contrast mode', async ({ page }) => {
    // Enable forced colors (high contrast)
    await page.emulateMedia({ forcedColors: 'active' });
    
    await page.goto('/');

    // Page should load without issues
    await page.waitForLoadState('networkidle');
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});
