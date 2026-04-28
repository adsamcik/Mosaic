/**
 * Admin Dashboard E2E Tests
 *
 * Tests for the Admin Panel: page load, dashboard stats, user/album tables,
 * tab switching, and navigation back to albums.
 *
 * The admin page makes 5 concurrent API calls that overwhelm Docker backends.
 * We mock ALL 5 admin endpoints so the admin page loads instantly without
 * hitting the real backend. This tests the admin UI rendering and navigation.
 */

import { test, expect, loginUser, type AuthenticatedUser } from '../fixtures-enhanced';
import { AppShell, AdminPage } from '../page-objects';
import { API_URL } from '../framework';
import type { Page } from '@playwright/test';

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
 * Mock the 4 expensive admin API endpoints so the admin page loads instantly.
 * Only `/api/admin/quota-defaults` hits the real backend (lightweight call).
 */
async function mockAdminApis(page: Page, userEmail: string): Promise<void> {
  const userId = '00000000-0000-0000-0000-000000000001';
  const albumId = '00000000-0000-0000-0000-000000000002';
  const now = new Date().toISOString();

  // Register near-limits BEFORE stats — Playwright matches routes in order,
  // and **/api/admin/stats would also match **/api/admin/stats/near-limits
  await page.route('**/api/admin/stats/near-limits', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usersNearStorageLimit: [],
        usersNearAlbumLimit: [],
        albumsNearPhotoLimit: [],
        albumsNearSizeLimit: [],
      }),
    });
  });

  await page.route('**/api/admin/stats', async (route) => {
    // Skip if this is actually the near-limits endpoint (shouldn't happen
    // because it's registered above, but guard anyway)
    if (route.request().url().includes('near-limits')) {
      return route.continue();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        totalUsers: 3,
        totalAlbums: 5,
        totalPhotos: 42,
        totalStorageBytes: 1024 * 1024 * 100,
      }),
    });
  });

  await page.route('**/api/admin/users', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: userId,
          authSub: userEmail,
          isAdmin: true,
          createdAt: now,
          albumCount: 2,
          totalStorageBytes: 1024 * 1024 * 50,
          quota: {
            currentStorageBytes: 1024 * 1024 * 50,
            currentAlbumCount: 2,
          },
        },
        {
          id: '00000000-0000-0000-0000-000000000099',
          authSub: 'other-user@test.local',
          isAdmin: false,
          createdAt: now,
          albumCount: 1,
          totalStorageBytes: 1024 * 1024 * 10,
          quota: {
            currentStorageBytes: 1024 * 1024 * 10,
            currentAlbumCount: 1,
          },
        },
      ]),
    });
  });

  await page.route('**/api/admin/albums', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: albumId,
          ownerId: userId,
          ownerAuthSub: userEmail,
          createdAt: now,
          photoCount: 10,
          totalSizeBytes: 1024 * 1024 * 25,
        },
        {
          id: '00000000-0000-0000-0000-000000000003',
          ownerId: userId,
          ownerAuthSub: userEmail,
          createdAt: now,
          photoCount: 5,
          totalSizeBytes: 1024 * 1024 * 12,
        },
      ]),
    });
  });

  await page.route('**/api/admin/settings/quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maxStorageBytes: 10737418240,
        maxAlbums: null,
      }),
    });
  });
}

/**
 * Login normally (register the user), promote to admin via backend API,
 * and make the frontend aware of admin status without a page reload.
 *
 * Sets up route interceptions BEFORE login so AppShell sees admin status
 * on first mount and admin API calls respond instantly from mocks.
 */
async function loginAsAdmin(user: AuthenticatedUser): Promise<void> {
  // Step 1: Mock expensive admin APIs (before any navigation)
  await mockAdminApis(user.page, user.email);

  // Step 2: Intercept GET /api/users/me to inject isAdmin: true.
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

  // Step 3: Register and login normally.
  await loginUser(user);

  // Step 4: Backend admin middleware checks the persisted database flag.
  await promoteToAdmin(user.email);
}

test.describe('Admin Dashboard @p2 @ui @admin @slow', () => {
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

    // Verify stat labels are displayed (values come from mocked stats)
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

    // Users table should be visible with header + 2 mocked user rows
    await expect(adminPage.userTable).toBeVisible();
    const rows = await adminPage.getUserRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test('albums tab shows album list', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');
    await loginAsAdmin(user);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await adminPage.openAlbums();

    // Albums table should be visible with header + 2 mocked album rows
    await expect(adminPage.albumTable).toBeVisible();
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
