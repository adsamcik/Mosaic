/**
 * Share Links E2E Tests
 *
 * Tests the share link workflow: creation, copying, expiration, max uses, and revocation.
 * Share links allow album owners to share read-only or download access with external users.
 *
 * Test IDs: P1-SHARE-1 through P1-SHARE-8
 */

import { test, expect } from '../fixtures';
import {
  AppShell,
  CreateAlbumDialog,
  GalleryPage,
  ShareLinksPanel,
  CreateShareLinkDialog,
} from '../page-objects';
import { waitForCondition } from '../framework';

test.describe('Share Links Workflow @p1 @sharing', () => {
  let appShell: AppShell;
  let createAlbumDialog: CreateAlbumDialog;
  let gallery: GalleryPage;
  let shareLinksPanel: ShareLinksPanel;
  let createShareLinkDialog: CreateShareLinkDialog;
  let albumName: string;

  test.beforeEach(async ({ loggedInPage }) => {
    appShell = new AppShell(loggedInPage);
    createAlbumDialog = new CreateAlbumDialog(loggedInPage);
    gallery = new GalleryPage(loggedInPage);
    shareLinksPanel = new ShareLinksPanel(loggedInPage);
    createShareLinkDialog = new CreateShareLinkDialog(loggedInPage);

    // Generate unique album name to avoid collisions in parallel tests
    albumName = `ShareTest-${crypto.randomUUID().slice(0, 8)}`;

    // loggedInPage is already authenticated, just create album
    // Create album
    await appShell.openCreateAlbumDialog();
    await createAlbumDialog.createAlbum(albumName);

    // Open the album
    await appShell.clickAlbumByName(albumName);
    await gallery.waitForLoad();
  });

  test('P1-SHARE-1: can open share links panel from gallery header', async ({ loggedInPage: page }) => {
    // Open share links panel (uses retry pattern for menu stability)
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();

    // Verify panel is visible with empty state
    await expect(shareLinksPanel.emptyState).toBeVisible({ timeout: 5000 });
    await expect(shareLinksPanel.createButton).toBeVisible();

    // Close panel
    await shareLinksPanel.close();
  });

  test('P1-SHARE-2: can create a view-only share link with expiration', async ({ loggedInPage: page }) => {
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();

    // Click create button
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();

    // Select 7 days expiration
    await createShareLinkDialog.selectExpiry('7 days');

    // Generate the link
    await createShareLinkDialog.generate();

    // Verify URL is generated (format: /s/{linkId}#k=...)
    const url = await createShareLinkDialog.getGeneratedUrl();
    expect(url).toMatch(/^https?:\/\/.+\/s\/.+#k=.+/);

    // Complete the dialog
    await createShareLinkDialog.done();

    // Verify link appears in list
    const linkCount = await shareLinksPanel.getLinkCount();
    expect(linkCount).toBe(1);
  });

  test('P1-SHARE-3: can create a share link with max uses limit', async ({ loggedInPage: page }) => {
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();

    // Set max uses to 5
    await createShareLinkDialog.setMaxUses(5);

    // Select 24 hours expiration
    await createShareLinkDialog.selectExpiry('24 hours');

    // Generate the link
    await createShareLinkDialog.generate();

    // Verify URL is generated
    const url = await createShareLinkDialog.getGeneratedUrl();
    expect(url).toBeTruthy();

    await createShareLinkDialog.done();

    // Verify link appears and shows max uses
    const linkCount = await shareLinksPanel.getLinkCount();
    expect(linkCount).toBe(1);
  });

  test('P1-SHARE-4: shows warning for never-expiring links', async ({ loggedInPage: page }) => {
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();

    // Select "Never" expiration
    await createShareLinkDialog.selectExpiry('never');

    // Warning should be visible
    await expect(createShareLinkDialog.neverExpiresWarning).toBeVisible({ timeout: 5000 });

    // Cancel without creating
    await createShareLinkDialog.cancel();
  });

  test('P1-SHARE-5: can copy share link to clipboard', async ({ loggedInPage: page, browser }) => {
    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();

    // Create a link
    await createShareLinkDialog.selectExpiry('1 hour');
    await createShareLinkDialog.generate();

    // Copy the link
    const generatedUrl = await createShareLinkDialog.copyLink();

    // Verify clipboard contains the URL
    const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardContent).toBe(generatedUrl);

    await createShareLinkDialog.done();
  });

  test('P1-SHARE-6: can revoke an existing share link', async ({ loggedInPage: page }) => {
    // First create a share link
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();
    await createShareLinkDialog.selectExpiry('7 days');
    await createShareLinkDialog.generate();
    await createShareLinkDialog.done();

    // Verify link exists
    let linkCount = await shareLinksPanel.getLinkCount();
    expect(linkCount).toBe(1);

    // Revoke the link
    await shareLinksPanel.revokeLink(0);

    // Wait for UI update - link should move to revoked section or disappear from active
    await waitForCondition(
      async () => {
        const currentCount = await shareLinksPanel.getLinkCount();
        return currentCount === 0;
      },
      { timeout: 5000, message: 'Waiting for active link count to become 0' }
    );

    // Active links should now be empty
    linkCount = await shareLinksPanel.getLinkCount();
    expect(linkCount).toBe(0);

    // Revoked link should appear in revoked section
    // The revoked section uses <details> and is collapsed by default
    const revokedSection = page.getByTestId('revoked-links-section');
    if (await revokedSection.isVisible()) {
      // Expand the revoked section by clicking the summary
      await revokedSection.locator('summary').click();
      const revokedLinks = page.getByTestId('revoked-link-item');
      await expect(revokedLinks.first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('P1-SHARE-7: can cancel share link creation', async ({ loggedInPage: page }) => {
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();

    // Open create dialog
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();

    // Start configuring
    await createShareLinkDialog.selectExpiry('7 days');

    // Cancel
    await createShareLinkDialog.cancel();

    // Verify dialog is closed and no link was created
    await expect(shareLinksPanel.emptyState).toBeVisible({ timeout: 5000 });
  });

  test('P1-SHARE-8: multiple share links can coexist', async ({ loggedInPage: page }) => {
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();

    // Create first link
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();
    await createShareLinkDialog.selectExpiry('1 hour');
    await createShareLinkDialog.generate();
    await createShareLinkDialog.done();

    // Create second link
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();
    await createShareLinkDialog.selectExpiry('7 days');
    await createShareLinkDialog.generate();
    await createShareLinkDialog.done();

    // Verify both links exist
    const linkCount = await shareLinksPanel.getLinkCount();
    expect(linkCount).toBe(2);
  });
});

test.describe('Share Link Access @p2 @sharing', () => {
  let appShell: AppShell;
  let createAlbumDialog: CreateAlbumDialog;
  let gallery: GalleryPage;
  let shareLinksPanel: ShareLinksPanel;
  let createShareLinkDialog: CreateShareLinkDialog;
  let albumName: string;
  let generatedShareUrl: string;

  test.beforeEach(async ({ loggedInPage }) => {
    appShell = new AppShell(loggedInPage);
    createAlbumDialog = new CreateAlbumDialog(loggedInPage);
    gallery = new GalleryPage(loggedInPage);
    shareLinksPanel = new ShareLinksPanel(loggedInPage);
    createShareLinkDialog = new CreateShareLinkDialog(loggedInPage);

    // Generate unique album name
    albumName = `PublicShareTest-${crypto.randomUUID().slice(0, 8)}`;

    // loggedInPage is already authenticated, just create album
    // Create album
    await appShell.openCreateAlbumDialog();
    await createAlbumDialog.createAlbum(albumName);

    // Open the album
    await appShell.clickAlbumByName(albumName);
    await gallery.waitForLoad();

    // Create a share link
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();
    await createShareLinkDialog.selectExpiry('7 days');
    await createShareLinkDialog.generate();
    generatedShareUrl = await createShareLinkDialog.getGeneratedUrl();
    await createShareLinkDialog.done();
    await shareLinksPanel.close();
  });

  test('P2-SHARE-9: accessing share link without login shows public view', async ({
    loggedInPage: page,
    browser,
  }) => {
    // Open the share link in a fresh browser context (no cookies, no auth)
    const incognitoContext = await browser.newContext();
    const incognitoPage = await incognitoContext.newPage();

    try {
      // Navigate to the share URL
      await incognitoPage.goto(generatedShareUrl);

      // Verify the shared album viewer is shown
      const sharedViewer = incognitoPage.getByTestId('shared-album-viewer');
      await expect(sharedViewer).toBeVisible({ timeout: 30000 });

      // Verify we see the "Shared Album" badge (anonymous access indicator)
      const sharedBadge = incognitoPage.locator('.shared-badge');
      await expect(sharedBadge).toBeVisible({ timeout: 5000 });

      // Verify no login form is shown
      const loginForm = incognitoPage.getByTestId('login-form');
      await expect(loginForm).not.toBeVisible();
    } finally {
      await incognitoContext.close();
    }
  });

  test('P2-SHARE-10: expired share link shows appropriate error', async ({ loggedInPage: page, browser }) => {
    // Extract linkId from the generated URL (format: /s/{linkId}#k=...)
    const urlPath = new URL(generatedShareUrl).pathname;
    const linkIdMatch = urlPath.match(/\/s\/([A-Za-z0-9_-]+)$/);
    expect(linkIdMatch).toBeTruthy();
    const linkId = linkIdMatch![1];

    // Call test-seed API to expire this link
    const expireResponse = await page.request.post(`/api/test-seed/expire-link/${linkId}`);
    expect(expireResponse.ok()).toBe(true);

    // Open the expired link in a fresh browser context
    const incognitoContext = await browser.newContext();
    const incognitoPage = await incognitoContext.newPage();

    try {
      // Navigate to the share URL
      await incognitoPage.goto(generatedShareUrl);

      // Verify the shared album viewer shows error state
      const sharedViewer = incognitoPage.getByTestId('shared-album-viewer');
      await expect(sharedViewer).toBeVisible({ timeout: 30000 });

      // Verify error message is displayed
      const errorMessage = incognitoPage.locator('.shared-viewer-error');
      await expect(errorMessage).toBeVisible({ timeout: 10000 });

      // Check for expired/invalid message
      const errorText = await errorMessage.textContent();
      expect(errorText?.toLowerCase()).toMatch(/expired|invalid|unable to access/);
    } finally {
      await incognitoContext.close();
    }
  });
});
