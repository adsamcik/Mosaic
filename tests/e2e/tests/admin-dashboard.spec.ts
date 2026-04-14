/**
 * Admin Dashboard E2E Tests
 *
 * Tests for the Admin Panel: page load, dashboard stats, user/album tables,
 * tab switching, and navigation back to albums.
 */

import { test, expect, loginUser, createAlbumViaUI, type AuthenticatedUser } from '../fixtures-enhanced';
import { AppShell, AdminPage } from '../page-objects';
import { API_URL } from '../framework';

/**
 * Promote a user to admin via the test-seed API.
 */
async function promoteToAdmin(email: string): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/test-seed/promote-admin/${encodeURIComponent(email)}`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(`Failed to promote ${email} to admin: ${response.status}`);
  }
}

/**
 * Login normally (register the user), promote to admin via backend API,
 * and make the frontend aware of admin status without a page reload.
 *
 * Uses Playwright route interception to inject isAdmin=true into
 * /api/users/me responses. This avoids the unreliable reload+re-login
 * cycle that caused flaky failures in CI Docker environments.
 */
async function loginAsAdmin(user: AuthenticatedUser): Promise<void> {
  // Step 1: Intercept GET /api/users/me to inject isAdmin: true.
  // Set up BEFORE login so AppShell sees admin status on first mount.
  await user.page.route('**/api/users/me', async (route) => {
    if (route.request().method() !== 'GET') {
      return route.continue();
    }
    const response = await route.fetch();
    if (!response.ok()) {
      return route.fulfill({ response });
    }
    const json = await response.json();
    json.isAdmin = true;
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify(json),
    });
  });

  // Step 2: Register and login normally.
  // AppShell mounts and sees isAdmin=true from the intercepted response.
  await loginUser(user);

  // Step 3: Promote to admin in the backend so admin API calls succeed.
  await promoteToAdmin(user.email);
}

test.describe('Admin Dashboard @p2 @ui @admin @slow', () => {
  // Run admin tests serially — they make heavy admin API calls that
  // overwhelm the Docker backend when running in parallel
  test.describe.configure({ mode: 'serial' });

  test('admin page loads successfully', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginAsAdmin(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await expect(adminPage.container).toBeVisible();
  });

  test('dashboard tab shows system statistics', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginAsAdmin(user);

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
    await loginAsAdmin(user);

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
    await loginAsAdmin(user);

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
    await loginAsAdmin(user);

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
    await loginAsAdmin(user);

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
