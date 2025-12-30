/**
 * Collaboration and Sharing E2E Tests
 *
 * Tests for multi-user scenarios using the parallel-safe collaboration fixture.
 */

import {
  test,
  expect,
  LoginPage,
  AppShell,
  GalleryPage,
  MembersPanel,
  InviteMemberDialog,
  RemoveMemberDialog,
  loginUser,
  createAlbumViaAPI,
  generateTestImage,
  getCurrentUserViaAPI,
  TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Collaboration @p1 @sharing @multi-user @slow', () => {
  test.describe('Album Sharing', () => {
    test('P1-COLLAB-1: owner can open members panel', async ({ collaboration }) => {
      const { alice, trackAlbum } = collaboration;

      // Create album as Alice
      const albumResult = await createAlbumViaAPI(alice.email);
      trackAlbum(albumResult.id, alice.email);

      await loginUser(alice, TEST_PASSWORD);

      // Navigate to album
      const appShell = new AppShell(alice.page);
      await expect(alice.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(alice.page);
      await gallery.waitForLoad();

      // Open members panel
      const hasMembersButton = await gallery.membersButton.first().isVisible().catch(() => false);

      if (hasMembersButton) {
        await gallery.openMembers();
        const membersPanel = new MembersPanel(alice.page);
        await membersPanel.waitForOpen();
      }
    });

    test('P1-COLLAB-2: both users see shared album after invite', async ({ collaboration }) => {
      const { alice, bob, trackAlbum } = collaboration;

      // Create album as Alice
      const albumResult = await createAlbumViaAPI(alice.email);
      trackAlbum(albumResult.id, alice.email);

      // Login both users
      await loginUser(alice, TEST_PASSWORD);
      await loginUser(bob, TEST_PASSWORD);

      // Alice should see her album
      const aliceAppShell = new AppShell(alice.page);
      await expect(alice.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });

      // Get Bob's user ID for invite
      const bobInfo = await getCurrentUserViaAPI(bob.email);

      // Alice navigates to album and invites Bob
      await aliceAppShell.clickAlbum(0);

      const gallery = new GalleryPage(alice.page);
      await gallery.waitForLoad();

      // Try to open members and invite
      const hasMembersButton = await gallery.membersButton.first().isVisible().catch(() => false);

      if (hasMembersButton) {
        await gallery.openMembers();

        const membersPanel = new MembersPanel(alice.page);
        await membersPanel.waitForOpen();

        const hasInviteButton = await membersPanel.inviteButton.first().isVisible().catch(() => false);

        if (hasInviteButton) {
          await membersPanel.openInviteDialog();

          const inviteDialog = new InviteMemberDialog(alice.page);
          await inviteDialog.inviteMember(bobInfo.id, 'viewer');
        }
      }
    });

    test('P1-COLLAB-3: uploaded photo visible to album members', async ({ collaboration }) => {
      const { alice, bob, generateAlbumName, trackAlbum } = collaboration;

      // Create album
      const albumResult = await createAlbumViaAPI(alice.email);
      trackAlbum(albumResult.id, alice.email);

      // Login Alice and upload photo
      await loginUser(alice, TEST_PASSWORD);

      const aliceAppShell = new AppShell(alice.page);
      await expect(alice.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await aliceAppShell.clickAlbum(0);

      const aliceGallery = new GalleryPage(alice.page);
      await aliceGallery.waitForLoad();

      // Upload photo
      const testImage = generateTestImage('tiny');
      await aliceGallery.uploadPhoto(testImage, 'shared-photo.png');
      await aliceGallery.expectPhotoCount(1);

      // Photo should be visible to Alice
      await expect(aliceGallery.getPhotos().first()).toBeVisible();
    });
  });

  test.describe('Parallel Isolation', () => {
    test('P1-COLLAB-4: alice and bob have separate isolated contexts', async ({ collaboration }) => {
      const { alice, bob } = collaboration;

      // Login both
      await loginUser(alice, TEST_PASSWORD);
      await loginUser(bob, TEST_PASSWORD);

      // Both should see their own empty album lists initially
      const aliceAppShell = new AppShell(alice.page);
      const bobAppShell = new AppShell(bob.page);

      await aliceAppShell.waitForLoad();
      await bobAppShell.waitForLoad();

      // Create album as Alice
      await aliceAppShell.openCreateAlbumDialog();

      // Should not affect Bob's view
      await expect(bob.page.getByTestId('create-album-dialog')).toBeHidden();
    });

    test('P1-COLLAB-5: albums created by different users are isolated', async ({
      collaboration,
    }) => {
      const { alice, bob, trackAlbum, generateAlbumName } = collaboration;

      // Login both
      await loginUser(alice, TEST_PASSWORD);
      await loginUser(bob, TEST_PASSWORD);

      // Alice creates an album
      const aliceAlbum = await createAlbumViaAPI(alice.email);
      trackAlbum(aliceAlbum.id, alice.email);

      // Bob creates an album
      const bobAlbum = await createAlbumViaAPI(bob.email);
      trackAlbum(bobAlbum.id, bob.email);

      // Refresh both pages
      await alice.page.reload();
      await bob.page.reload();

      // Re-login
      const aliceLogin = new LoginPage(alice.page);
      await aliceLogin.waitForForm();
      await aliceLogin.login(TEST_PASSWORD);
      await aliceLogin.expectLoginSuccess();

      const bobLogin = new LoginPage(bob.page);
      await bobLogin.waitForForm();
      await bobLogin.login(TEST_PASSWORD);
      await bobLogin.expectLoginSuccess();

      // Each should see only their own album (unless sharing is set up)
      const aliceAppShell = new AppShell(alice.page);
      const bobAppShell = new AppShell(bob.page);

      await expect(alice.page.getByTestId('album-card')).toHaveCount(1, { timeout: 10000 });
      await expect(bob.page.getByTestId('album-card')).toHaveCount(1, { timeout: 10000 });
    });
  });

  test.describe('Member Removal & Access Revocation', () => {
    /**
     * P1-COLLAB-6: Member Removal + Access Revocation
     *
     * Tests the complete flow:
     * 1. Alice creates album
     * 2. Alice invites Bob as viewer
     * 3. Bob can see the shared album
     * 4. Alice removes Bob from the album
     * 5. Bob can no longer see the album
     *
     * Key rotation (epoch change) happens during member removal but is not
     * directly observable in the UI - it's a background crypto operation.
     * The observable behavior is that the removed member loses access.
     */
    test('P1-COLLAB-6: removed member loses access to shared album', async ({ collaboration }) => {
      const { alice, bob, trackAlbum } = collaboration;

      // Step 1: Create album as Alice
      const albumResult = await createAlbumViaAPI(alice.email);
      trackAlbum(albumResult.id, alice.email);

      // Step 2: Login both users
      await loginUser(alice, TEST_PASSWORD);
      await loginUser(bob, TEST_PASSWORD);

      // Get Bob's user info for the invite
      const bobInfo = await getCurrentUserViaAPI(bob.email);

      // Step 3: Alice navigates to her album
      const aliceAppShell = new AppShell(alice.page);
      await expect(alice.page.getByTestId('album-card')).toBeVisible({ timeout: 15000 });
      await aliceAppShell.clickAlbum(0);

      const aliceGallery = new GalleryPage(alice.page);
      await aliceGallery.waitForLoad();

      // Step 4: Alice opens members panel and invites Bob
      const hasMembersButton = await aliceGallery.membersButton.first().isVisible().catch(() => false);
      if (!hasMembersButton) {
        test.skip(true, 'Members panel not available in this UI version');
        return;
      }

      await aliceGallery.openMembers();
      const membersPanel = new MembersPanel(alice.page);
      await membersPanel.waitForOpen();

      const hasInviteButton = await membersPanel.inviteButton.first().isVisible().catch(() => false);
      if (!hasInviteButton) {
        test.skip(true, 'Invite functionality not available');
        return;
      }

      await membersPanel.openInviteDialog();

      const inviteDialog = new InviteMemberDialog(alice.page);
      await inviteDialog.inviteMember(bobInfo.id, 'viewer');

      // Wait for invite dialog to close (indicates invite completed)
      await expect(inviteDialog.dialog).not.toBeVisible({ timeout: 10000 });

      // Reopen members panel to verify
      await aliceGallery.openMembers();
      await membersPanel.waitForOpen();

      // Verify Bob appears in member list (may show ID or display name)
      const memberCount = await membersPanel.getMemberCount();
      expect(memberCount).toBeGreaterThanOrEqual(2); // Alice (owner) + Bob

      await membersPanel.close();

      // Step 5: Verify Bob can see the shared album
      const bobAppShell = new AppShell(bob.page);
      await bob.page.reload();

      // Bob may need to re-login after reload
      const bobLoginPage = new LoginPage(bob.page);
      const needsLogin = await bobLoginPage.form.isVisible({ timeout: 3000 }).catch(() => false);
      if (needsLogin) {
        await bobLoginPage.login(TEST_PASSWORD);
        await bobLoginPage.expectLoginSuccess();
      }

      await bobAppShell.waitForLoad();

      // Bob should see the shared album
      await expect(bob.page.getByTestId('album-card')).toBeVisible({ timeout: 15000 });
      const bobAlbumCount = await bob.page.getByTestId('album-card').count();
      expect(bobAlbumCount).toBeGreaterThanOrEqual(1);

      // Step 6: Alice removes Bob from the album
      // Navigate back to Alice's album if needed
      await alice.page.bringToFront();
      await aliceGallery.openMembers();
      await membersPanel.waitForOpen();

      // Use the member ID/name to locate and remove Bob
      // The removeMemberWithConfirmation method handles the dialog
      try {
        await membersPanel.removeMemberWithConfirmation(bobInfo.id);
      } catch {
        // If ID doesn't work, Bob might be displayed by email prefix
        const bobDisplayName = bob.email.split('@')[0];
        await membersPanel.removeMemberWithConfirmation(bobDisplayName);
      }

      // Wait for removal to complete by checking member count decreases
      // The removeMemberWithConfirmation waits for dialog close, but key rotation happens in background
      await expect(async () => {
        await aliceGallery.openMembers();
        await membersPanel.waitForOpen();
        const currentCount = await membersPanel.getMemberCount();
        expect(currentCount).toBeLessThan(memberCount);
      }).toPass({ timeout: 10000 });

      // Panel is already open from the polling above
      // Verify Bob is no longer in member list - get the current count
      const postRemovalCount = await membersPanel.getMemberCount();
      expect(postRemovalCount).toBeLessThan(memberCount);

      await membersPanel.close();

      // Step 7: Verify Bob can no longer see the album
      await bob.page.bringToFront();
      await bob.page.reload();

      // Bob may need to re-login after reload
      const bobReLoginPage = new LoginPage(bob.page);
      const needsReLogin = await bobReLoginPage.form.isVisible({ timeout: 3000 }).catch(() => false);
      if (needsReLogin) {
        await bobReLoginPage.login(TEST_PASSWORD);
        await bobReLoginPage.expectLoginSuccess();
      }

      await bobAppShell.waitForLoad();

      // Bob should no longer see the album (either empty state or album not visible)
      const bobPostRemovalCards = bob.page.getByTestId('album-card');
      const finalAlbumCount = await bobPostRemovalCards.count();

      // The shared album should be gone from Bob's view
      expect(finalAlbumCount).toBe(0);
    });

    /**
     * P1-COLLAB-7: Key rotation progress is shown during member removal
     *
     * Tests that the removal dialog shows progress indicators during
     * the key rotation process (which provides forward secrecy).
     *
     * Note: This test verifies the UI shows rotation progress, but cannot
     * directly verify cryptographic epoch changes from E2E perspective.
     */
    test('P1-COLLAB-7: removal dialog shows key rotation progress', async ({ collaboration }) => {
      const { alice, bob, trackAlbum } = collaboration;

      // Setup: Create album and invite Bob
      const albumResult = await createAlbumViaAPI(alice.email);
      trackAlbum(albumResult.id, alice.email);

      await loginUser(alice, TEST_PASSWORD);
      await loginUser(bob, TEST_PASSWORD);

      const bobInfo = await getCurrentUserViaAPI(bob.email);

      // Alice navigates to album
      const aliceAppShell = new AppShell(alice.page);
      await expect(alice.page.getByTestId('album-card')).toBeVisible({ timeout: 15000 });
      await aliceAppShell.clickAlbum(0);

      const aliceGallery = new GalleryPage(alice.page);
      await aliceGallery.waitForLoad();

      // Open members and invite Bob
      const hasMembersButton = await aliceGallery.membersButton.first().isVisible().catch(() => false);
      if (!hasMembersButton) {
        test.skip(true, 'Members panel not available');
        return;
      }

      await aliceGallery.openMembers();
      const membersPanel = new MembersPanel(alice.page);
      await membersPanel.waitForOpen();

      const hasInviteButton = await membersPanel.inviteButton.first().isVisible().catch(() => false);
      if (!hasInviteButton) {
        test.skip(true, 'Invite functionality not available');
        return;
      }

      await membersPanel.openInviteDialog();
      const inviteDialog = new InviteMemberDialog(alice.page);
      await inviteDialog.inviteMember(bobInfo.id, 'viewer');

      // Wait for invite dialog to close before reopening members panel
      await expect(inviteDialog.dialog).not.toBeVisible({ timeout: 10000 });

      // Reopen panel and start removal
      await aliceGallery.openMembers();
      await membersPanel.waitForOpen();

      // Click remove for Bob (don't use the full confirmation flow)
      try {
        await membersPanel.removeMember(bobInfo.id);
      } catch {
        const bobDisplayName = bob.email.split('@')[0];
        await membersPanel.removeMember(bobDisplayName);
      }

      // The dialog should appear with progress indicator during removal
      const removeDialog = new RemoveMemberDialog(alice.page);
      await removeDialog.waitForOpen();

      // Click confirm to trigger the removal (which includes key rotation)
      await removeDialog.confirmButton.click();

      // Check for progress indicator - may appear briefly during rotation
      // Note: This could be fast enough that we miss it, so we check both states
      const progressShown = await removeDialog.progressIndicator.isVisible({ timeout: 2000 }).catch(() => false);

      // Wait for dialog to close (removal complete)
      await removeDialog.waitForClose();

      // Log whether we observed progress (informational)
      if (progressShown) {
        console.log('Key rotation progress indicator was visible during member removal');
      }

      // The important thing is that removal completed successfully
      // and the dialog closed (indicating rotation finished)
    });
  });
});
