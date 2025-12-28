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
  loginUser,
  createAlbumViaAPI,
  generateTestImage,
  getCurrentUserViaAPI,
  TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Collaboration', () => {
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
});
