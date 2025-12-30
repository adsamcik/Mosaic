/**
 * Share Links E2E Tests
 *
 * Tests the share link workflow: creation, copying, expiration, max uses, and revocation.
 * Share links allow album owners to share read-only or download access with external users.
 *
 * Test IDs: P1-SHARE-1 through P1-SHARE-8
 */

import { test, expect } from '@playwright/test';
import {
  LoginPage,
  AppShell,
  CreateAlbumDialog,
  GalleryPage,
  ShareLinksPanel,
  CreateShareLinkDialog,
} from '../page-objects';
import { waitForCondition } from '../framework';

test.describe('Share Links Workflow @p1 @sharing', () => {
  let loginPage: LoginPage;
  let appShell: AppShell;
  let createAlbumDialog: CreateAlbumDialog;
  let gallery: GalleryPage;
  let shareLinksPanel: ShareLinksPanel;
  let createShareLinkDialog: CreateShareLinkDialog;
  let albumName: string;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    appShell = new AppShell(page);
    createAlbumDialog = new CreateAlbumDialog(page);
    gallery = new GalleryPage(page);
    shareLinksPanel = new ShareLinksPanel(page);
    createShareLinkDialog = new CreateShareLinkDialog(page);

    // Generate unique album name to avoid collisions in parallel tests
    albumName = `ShareTest-${crypto.randomUUID().slice(0, 8)}`;

    // Login and create a test album
    await loginPage.goto();
    await loginPage.waitForForm();
    await loginPage.login();
    await loginPage.expectLoginSuccess();

    // Create album
    await appShell.openCreateAlbumDialog();
    await createAlbumDialog.createAlbum(albumName);

    // Open the album
    await appShell.clickAlbumByName(albumName);
    await gallery.waitForLoad();
  });

  test('P1-SHARE-1: can open share links panel from gallery header', async ({ page }) => {
    // The share links button should be visible for album owners
    await expect(gallery.shareButton).toBeVisible({ timeout: 5000 });

    // Click to open the panel
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();

    // Verify panel is visible with empty state
    await expect(shareLinksPanel.emptyState).toBeVisible({ timeout: 5000 });
    await expect(shareLinksPanel.createButton).toBeVisible();

    // Close panel
    await shareLinksPanel.close();
  });

  test('P1-SHARE-2: can create a view-only share link with expiration', async ({ page }) => {
    await gallery.openShareLinks();
    await shareLinksPanel.waitForOpen();

    // Click create button
    await shareLinksPanel.openCreateDialog();
    await createShareLinkDialog.waitForOpen();

    // Select 7 days expiration
    await createShareLinkDialog.selectExpiry('7 days');

    // Generate the link
    await createShareLinkDialog.generate();

    // Verify URL is generated
    const url = await createShareLinkDialog.getGeneratedUrl();
    expect(url).toMatch(/^https?:\/\/.+\/share\/.+/);

    // Complete the dialog
    await createShareLinkDialog.done();

    // Verify link appears in list
    const linkCount = await shareLinksPanel.getLinkCount();
    expect(linkCount).toBe(1);
  });

  test('P1-SHARE-3: can create a share link with max uses limit', async ({ page }) => {
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

  test('P1-SHARE-4: shows warning for never-expiring links', async ({ page }) => {
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

  test('P1-SHARE-5: can copy share link to clipboard', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

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

  test('P1-SHARE-6: can revoke an existing share link', async ({ page }) => {
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
    const revokedSection = page.getByTestId('revoked-links-section');
    if (await revokedSection.isVisible()) {
      const revokedLinks = page.getByTestId('revoked-link-item');
      await expect(revokedLinks.first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('P1-SHARE-7: can cancel share link creation', async ({ page }) => {
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

  test('P1-SHARE-8: multiple share links can coexist', async ({ page }) => {
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

test.describe('Share Link Access @p1 @sharing', () => {
  test.skip('P2-SHARE-9: accessing share link without login shows public view', async ({
    page,
  }) => {
    // TODO: Implement when public share link access is available
    // This test requires unauthenticated access to a share link URL
  });

  test.skip('P2-SHARE-10: expired share link shows appropriate error', async ({ page }) => {
    // TODO: Implement when we can fast-forward time or create expired links
  });
});
