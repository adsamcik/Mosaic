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
    `${API_URL}/api/v1/test-seed/promote-admin/${encodeURIComponent(email)}`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(`Failed to promote ${email} to admin: ${response.status}`);
  }
}

/**
 * Assert that any `skip` / `take` query parameter on the URL is either
 * absent or a valid non-negative pagination value (skip >= 0, take >= 1).
 * Catches regressions where paginateAll forwards bogus values to admin
 * endpoints (e.g. negative skip, take=0, NaN).
 */
function assertPaginationQuery(url: string): void {
  const parsed = new URL(url);
  const skip = parsed.searchParams.get('skip');
  const take = parsed.searchParams.get('take');
  if (skip !== null) {
    const skipNum = Number(skip);
    expect(Number.isInteger(skipNum)).toBe(true);
    expect(skipNum).toBeGreaterThanOrEqual(0);
  }
  if (take !== null) {
    const takeNum = Number(take);
    expect(Number.isInteger(takeNum)).toBe(true);
    expect(takeNum).toBeGreaterThan(0);
  }
}

/**
 * Mock the 4 expensive admin API endpoints so the admin page loads instantly.
 * Only `/api/v1/admin/quota-defaults` hits the real backend (lightweight call).
 */
async function mockAdminApis(page: Page, userEmail: string): Promise<void> {
  // RFC 4122 v4 UUIDs (version nibble = 4, variant nibble = 8/9/a/b).
  // The frontend's Zod schemas use `z.string().uuid()` which rejects
  // nil UUIDs (00000000-...) — those have version=0 and would surface
  // as a 500 "Invalid response shape" in the admin page error state.
  const userId = '11111111-1111-4111-8111-111111111111';
  const albumId = '22222222-2222-4222-8222-222222222222';
  const now = new Date().toISOString();

  // Register near-limits BEFORE stats — Playwright matches routes in order,
  // and **/api/v1/admin/stats would also match **/api/v1/admin/stats/near-limits
  await page.route('**/api/v1/admin/stats/near-limits', async (route) => {
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

  await page.route('**/api/v1/admin/stats', async (route) => {
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

  // Backend wraps list responses in a PagedResult envelope:
  //   { items: [...], nextSkip: number | null }
  // The frontend's Zod schemas (AdminUserListEnvelopeSchema /
  // AdminAlbumListEnvelopeSchema) require this shape — returning a bare
  // array causes schema validation to fail and the admin page lands in
  // the error state with empty tables. Keep mocks aligned with the real
  // contract introduced in commit 3dab0b22 (feat(api): wrap list responses
  // in PagedResult envelope).
  //
  // v1.0.2 hardening: the mock asserts query params are either absent or
  // valid non-negative pagination values so we catch regressions where
  // paginateAll / listUsers sends malformed `skip` / `take`.
  await page.route('**/api/v1/admin/users**', async (route) => {
    assertPaginationQuery(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
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
            id: '99999999-9999-4999-8999-999999999999',
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
        ],
        nextSkip: null,
      }),
    });
  });

  await page.route('**/api/v1/admin/albums**', async (route) => {
    assertPaginationQuery(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: albumId,
            ownerId: userId,
            ownerAuthSub: userEmail,
            createdAt: now,
            photoCount: 10,
            totalSizeBytes: 1024 * 1024 * 25,
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            ownerId: userId,
            ownerAuthSub: userEmail,
            createdAt: now,
            photoCount: 5,
            totalSizeBytes: 1024 * 1024 * 12,
          },
        ],
        nextSkip: null,
      }),
    });
  });

  await page.route('**/api/v1/admin/settings/quota', async (route) => {
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

  // Step 2: Intercept GET /api/v1/users/me to inject isAdmin: true.
  await user.page.route('**/api/v1/users/me', async (route) => {
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

  // v1.0.2 — dedicated coverage for paginateAll across multiple pages.
  // Existing mocks set nextSkip:null and return short pages (length < 100),
  // which causes paginateAll to terminate after the first fetch. That left
  // the multi-page code path (skip advances, additional fetches issued,
  // results concatenated) untested. This test wires a stateful mock that
  // returns three full pages (100 + 100 + 50) and asserts every page was
  // requested with monotonically increasing `skip` and that the final UI
  // rendered all 250 rows.
  test('paginateAll fetches all pages and combines users', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('admin');

    // Build the stateful mock BEFORE login so the admin page's first load
    // hits it.
    const userId = '11111111-1111-4111-8111-111111111111';
    const albumId = '22222222-2222-4222-8222-222222222222';
    const now = new Date().toISOString();

    // Mock near-limits + stats + albums + settings (default short responses).
    await user.page.route('**/api/v1/admin/stats/near-limits', async (route) => {
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

    await user.page.route('**/api/v1/admin/stats', async (route) => {
      if (route.request().url().includes('near-limits')) {
        return route.continue();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalUsers: 250,
          totalAlbums: 1,
          totalPhotos: 0,
          totalStorageBytes: 0,
        }),
      });
    });

    await user.page.route('**/api/v1/admin/albums**', async (route) => {
      assertPaginationQuery(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: albumId,
              ownerId: userId,
              ownerAuthSub: user.email,
              createdAt: now,
              photoCount: 0,
              totalSizeBytes: 0,
            },
          ],
          nextSkip: null,
        }),
      });
    });

    await user.page.route('**/api/v1/admin/settings/quota', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          maxStorageBytes: 10737418240,
          maxAlbums: null,
        }),
      });
    });

    // Stateful multi-page users mock. paginateAll terminates when a page's
    // length is < pageSize (100), so we return 100, 100, 50.
    const PAGE_SIZE = 100;
    const TOTAL = 250;
    const observedSkips: number[] = [];
    const makeUser = (i: number) => {
      // RFC 4122 v4 UUIDs derived from i (version nibble = 4, variant 8).
      const hex = i.toString(16).padStart(12, '0');
      return {
        id: `00000000-0000-4000-8000-${hex}`,
        authSub: `user-${i}@test.local`,
        isAdmin: false,
        createdAt: now,
        albumCount: 0,
        totalStorageBytes: 0,
        quota: {
          currentStorageBytes: 0,
          currentAlbumCount: 0,
        },
      };
    };

    await user.page.route('**/api/v1/admin/users**', async (route) => {
      const url = new URL(route.request().url());
      assertPaginationQuery(url.toString());
      const skip = Number(url.searchParams.get('skip') ?? '0');
      const take = Number(url.searchParams.get('take') ?? String(PAGE_SIZE));
      observedSkips.push(skip);
      const end = Math.min(skip + take, TOTAL);
      const items: ReturnType<typeof makeUser>[] = [];
      for (let i = skip; i < end; i++) items.push(makeUser(i));
      const remaining = TOTAL - end;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          nextSkip: remaining > 0 ? end : null,
        }),
      });
    });

    // Inject isAdmin and login.
    await user.page.route('**/api/v1/users/me', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const json = await response.json();
      json.isAdmin = true;
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    });

    await loginUser(user);
    await promoteToAdmin(user.email);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();
    await appShell.openAdmin();

    const adminPage = new AdminPage(user.page);
    await adminPage.waitForLoad();

    await adminPage.openUsers();
    await expect(adminPage.userTable).toBeVisible();

    // Wait for the third page to land. paginateAll must request skip=0,
    // skip=100, skip=200 (in that order) and terminate when the 50-item
    // page comes back.
    await expect
      .poll(() => observedSkips.length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(3);

    expect(observedSkips.slice(0, 3)).toEqual([0, 100, 200]);

    // The UI should render every row (header + 250 user rows).
    const rows = await adminPage.getUserRows();
    expect(rows.length).toBeGreaterThanOrEqual(TOTAL);
  });
});
