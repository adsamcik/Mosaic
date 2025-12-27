/**
 * Album Management Tests
 *
 * Tests for creating and managing albums.
 */

import { test, expect, AppShell, ApiHelper } from '../fixtures';

test.describe('Album Management', () => {
  const apiHelper = new ApiHelper();

  test('displays album list after login', async ({ authenticatedPage, testUser }) => {
    // Create an album via API first
    await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');

    const appShell = new AppShell(authenticatedPage);

    // Wait for app to load (may need to handle login first)
    await expect(async () => {
      const albumList = authenticatedPage.getByTestId('album-list');
      await expect(albumList).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });
  });

  test('shows empty state for new user', async ({ authenticatedPage, testUser }) => {
    await authenticatedPage.goto('/');

    // Look for empty state message or create album prompt
    await expect(async () => {
      const emptyState = authenticatedPage.getByText(/no albums|create.*album|get started/i);
      const createButton = authenticatedPage.getByRole('button', { name: /create|new/i });
      
      const hasEmptyState = await emptyState.first().isVisible().catch(() => false);
      const hasCreateButton = await createButton.first().isVisible().catch(() => false);
      
      expect(hasEmptyState || hasCreateButton).toBeTruthy();
    }).toPass({ timeout: 30000 });
  });

  test('can create a new album', async ({ authenticatedPage, testUser }) => {
    await authenticatedPage.goto('/');

    // Find and click create album button
    const createButton = authenticatedPage.getByRole('button', { name: /create|new/i });
    
    await expect(async () => {
      await expect(createButton.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    await createButton.first().click();

    // Should show album created or navigate to album
    await expect(async () => {
      const albumCard = authenticatedPage.getByTestId('album-card');
      const albumView = authenticatedPage.getByTestId('gallery');
      
      const hasCard = await albumCard.first().isVisible().catch(() => false);
      const hasView = await albumView.isVisible().catch(() => false);
      
      expect(hasCard || hasView).toBeTruthy();
    }).toPass({ timeout: 10000 });
  });

  test('album persists after page reload', async ({ authenticatedPage, testUser }) => {
    // Create album via API
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');

    // Wait for album to appear
    await expect(async () => {
      const albumList = authenticatedPage.getByTestId('album-list');
      await expect(albumList).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // Reload page
    await authenticatedPage.reload();

    // Album should still be visible
    await expect(async () => {
      const albumList = authenticatedPage.getByTestId('album-list');
      await expect(albumList).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });
  });
});
