/**
 * Admin Dashboard E2E Tests
 *
 * Tests for the Admin Panel: page load, dashboard stats, user/album tables,
 * tab switching, and navigation back to albums.
 */

import { test, expect, loginUser, createAlbumViaUI } from '../fixtures-enhanced';
import { AppShell, AdminPage } from '../page-objects';
import { API_URL } from '../framework';

/**
 * Create a test user in the backend via test-seed API and promote to admin.
 * This ensures the user has IsAdmin=true BEFORE login, so the frontend
 * sees admin status from the first /api/users/me response.
 */
async function ensureAdminUser(email: string): Promise<void> {
  // Create user via test-seed (idempotent - returns 409 if exists)
  await fetch(`${API_URL}/api/test-seed/create-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, authMode: 'local' }),
  });

  // Promote to admin
  const promoteResponse = await fetch(
    `${API_URL}/api/test-seed/promote-admin/${encodeURIComponent(email)}`,
    { method: 'POST' },
  );
  if (!promoteResponse.ok) {
    throw new Error(`Failed to promote ${email} to admin: ${promoteResponse.status}`);
  }
}

test.describe('Admin Dashboard @p2 @ui @admin @slow', () => {

  test('admin page loads successfully', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await ensureAdminUser(user.email);
    await loginUser(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await expect(adminPage.container).toBeVisible();
  });

  test('dashboard tab shows system statistics', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await ensureAdminUser(user.email);
    await loginUser(user);

    const appShell = new AppShell(user.page);
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
    await ensureAdminUser(user.email);
    await loginUser(user);

    const appShell = new AppShell(user.page);
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
    await ensureAdminUser(user.email);
    await loginUser(user);

    const appShell = new AppShell(user.page);
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
  });

  test('can switch between all tabs', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await ensureAdminUser(user.email);
    await loginUser(user);

    const appShell = new AppShell(user.page);
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

    // Switch to Albums tab
    await adminPage.openAlbums();
    await expect(adminPage.albumsTab).toHaveAttribute('aria-selected', 'true');

    // Switch to Settings tab
    await adminPage.openSettings();
    await expect(adminPage.settingsTab).toHaveAttribute('aria-selected', 'true');

    // Switch back to Dashboard
    await adminPage.openDashboard();
    await expect(adminPage.dashboardTab).toHaveAttribute('aria-selected', 'true');
  });

  test('admin navigation: can return to albums', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await ensureAdminUser(user.email);
    await loginUser(user);

    const appShell = new AppShell(user.page);
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
