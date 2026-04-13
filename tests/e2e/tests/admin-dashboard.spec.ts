/**
 * Admin Dashboard E2E Tests
 *
 * Tests for the Admin Panel: page load, dashboard stats, user/album tables,
 * tab switching, and navigation back to albums.
 */

import { test, expect, loginUser, createAlbumViaUI } from '../fixtures-enhanced';
import { AppShell, AdminPage } from '../page-objects';
import { API_URL } from '../framework';

async function promoteToAdmin(email: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/test-seed/promote-admin/${encodeURIComponent(email)}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Failed to promote ${email} to admin: ${response.status}`);
  }
}

test.describe('Admin Dashboard @p2 @ui @admin @slow', () => {
  // Admin tests require multiple admin API calls that are slow in CI Docker.
  // Skip in CI to avoid flaky failures — run locally or in nightly suite.
  test.skip(!!process.env.CI, 'Admin API too slow in CI Docker containers');

  test('admin page loads successfully', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await promoteToAdmin(user.email);
    await user.page.reload();
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await expect(adminPage.container).toBeVisible();
  });

  test('dashboard tab shows system statistics', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await promoteToAdmin(user.email);
    await user.page.reload();
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    // Dashboard is the default tab
    await expect(adminPage.dashboardTab).toHaveAttribute('aria-selected', 'true');

    // Verify stat labels are displayed
    await expect(user.page.getByText('Total Users')).toBeVisible({ timeout: 10000 });
    await expect(user.page.getByText('Total Albums')).toBeVisible();
  });

  test('users tab shows user list', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await promoteToAdmin(user.email);
    await user.page.reload();
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await adminPage.openUsers();

    // Users table should be visible with at least one row
    await expect(adminPage.userTable).toBeVisible();
    const rows = await adminPage.getUserRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test('albums tab shows album list', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await promoteToAdmin(user.email);
    await user.page.reload();
    await appShell.waitForLoad();

    // Create an album via UI first
    const albumName = `Admin Test Album ${Date.now()}`;
    await createAlbumViaUI(user.page, albumName);

    // Navigate back to album list, then open admin
    await appShell.goBack();
    await appShell.waitForLoad();
    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await adminPage.openAlbums();

    // Albums table should be visible
    await expect(adminPage.albumTable).toBeVisible();

    // Should have at least one album row plus the header row
    const rows = await adminPage.getAlbumRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Verify table headers
    const thead = adminPage.albumTable.locator('thead');
    await expect(thead.getByText('Owner')).toBeVisible();
    await expect(thead.getByText('Photos')).toBeVisible();
    await expect(thead.getByText('Size')).toBeVisible();

    // Verify the album owner matches our user
    await expect(adminPage.albumTable.locator('tbody').getByText(user.email)).toBeVisible({ timeout: 5000 });
  });

  test('can switch between all tabs', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await promoteToAdmin(user.email);
    await user.page.reload();
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    // Dashboard is the default tab
    await expect(adminPage.dashboardTab).toHaveAttribute('aria-selected', 'true');
    await expect(user.page.locator('.admin-dashboard-tab')).toBeVisible();

    // Switch to Users tab
    await adminPage.openUsers();
    await expect(adminPage.usersTab).toHaveAttribute('aria-selected', 'true');
    await expect(user.page.locator('.users-tab')).toBeVisible();
    await expect(user.page.locator('.admin-dashboard-tab')).not.toBeVisible();

    // Switch to Albums tab
    await adminPage.openAlbums();
    await expect(adminPage.albumsTab).toHaveAttribute('aria-selected', 'true');
    await expect(user.page.locator('.albums-tab')).toBeVisible();
    await expect(user.page.locator('.users-tab')).not.toBeVisible();

    // Switch to Settings tab
    await adminPage.openSettings();
    await expect(adminPage.settingsTab).toHaveAttribute('aria-selected', 'true');
    await expect(user.page.locator('.settings-tab')).toBeVisible();
    await expect(user.page.locator('.albums-tab')).not.toBeVisible();

    // Switch back to Dashboard
    await adminPage.openDashboard();
    await expect(adminPage.dashboardTab).toHaveAttribute('aria-selected', 'true');
    await expect(user.page.locator('.admin-dashboard-tab')).toBeVisible();
    await expect(user.page.locator('.settings-tab')).not.toBeVisible();
  });

  test('admin navigation: can return to albums', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await promoteToAdmin(user.email);
    await user.page.reload();
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    // Click the Back button inside the admin page
    await user.page.locator('.admin-header .back-button').click();

    // Should return to the album list
    await appShell.expectAlbumListVisible();

    // Admin page should no longer be visible
    await expect(adminPage.container).not.toBeVisible();
  });
});
