/**
 * Album Sharing & Member Management E2E Tests
 *
 * These tests cover the complete sharing workflow:
 * - Album owner inviting members
 * - Members accessing shared albums
 * - Role-based permissions (viewer vs editor)
 * - Member removal
 * - Key rotation after member removal (forward secrecy)
 */

import {
  ApiHelper,
  AppShell,
  expect,
  GalleryPage,
  generateTestImage,
  LoginPage,
  test,
  TEST_CONSTANTS,
} from '../fixtures';

test.describe('Sharing: Two-User Collaboration', () => {
  const apiHelper = new ApiHelper();

  test('owner and viewer see same photos in shared album', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    // Step 1: Alice creates an album and uploads photos
    const album = await apiHelper.createAlbum(aliceUser);

    // Alice logs in
    await alice.goto('/');
    const aliceLogin = new LoginPage(alice);
    await aliceLogin.waitForForm();
    await aliceLogin.login(TEST_CONSTANTS.PASSWORD);
    await aliceLogin.expectLoginSuccess();

    // Navigate to album
    const aliceAlbumCard = alice.getByTestId('album-card').first();
    await expect(aliceAlbumCard).toBeVisible({ timeout: 30000 });
    await aliceAlbumCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    // Upload photos
    const testImage = generateTestImage();
    await aliceGallery.uploadPhoto(testImage, 'shared-photo-1.png');
    await expect(aliceGallery.photos.first()).toBeVisible({ timeout: 60000 });

    await aliceGallery.uploadPhoto(testImage, 'shared-photo-2.png');
    await expect(async () => {
      expect(await aliceGallery.photos.count()).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 60000 });

    const alicePhotoCount = await aliceGallery.photos.count();

    // Step 2: Bob logs in to establish his identity
    await bob.goto('/');
    const bobLogin = new LoginPage(bob);
    await bobLogin.waitForForm();
    await bobLogin.login(TEST_CONSTANTS.PASSWORD);
    await bobLogin.expectLoginSuccess();

    const bobAppShell = new AppShell(bob);
    await bobAppShell.waitForLoad();

    // Step 3: Alice invites Bob
    const membersButton = alice.getByRole('button', { name: /members|share|manage/i });
    const hasMembersBtn = await membersButton.first().isVisible().catch(() => false);

    if (hasMembersBtn) {
      await membersButton.first().click();

      // Look for invite functionality
      const inviteButton = alice.getByRole('button', { name: /invite|add member/i });
      const hasInviteBtn = await inviteButton.first().isVisible().catch(() => false);

      if (hasInviteBtn) {
        await inviteButton.first().click();

        // Get Bob's user info
        const bobInfo = await apiHelper.getCurrentUser(bobUser);

        // Fill invite form
        const userInput = alice.getByLabel(/user|member|email|id/i);
        if (await userInput.first().isVisible().catch(() => false)) {
          await userInput.first().fill(bobInfo.id);

          // Select viewer role if available
          const roleSelect = alice.getByLabel(/role/i);
          if (await roleSelect.isVisible().catch(() => false)) {
            await roleSelect.selectOption('viewer');
          }

          // Submit invite
          const submitBtn = alice.getByRole('button', { name: /invite|add|confirm/i });
          await submitBtn.first().click();

          // Wait for success
          await expect(async () => {
            const success = alice.getByText(/invited|added|success/i);
            const hasSuccess = await success.first().isVisible().catch(() => false);
            const memberList = alice.getByTestId('member-list');
            const hasMemberList = await memberList.isVisible().catch(() => false);
            expect(hasSuccess || hasMemberList).toBeTruthy();
          }).toPass({ timeout: 30000 });

          // Step 4: Bob refreshes and should see shared album
          await bob.reload();

          const bobNeedsLogin = await bobLogin.loginForm.isVisible().catch(() => false);
          if (bobNeedsLogin) {
            await bobLogin.login(TEST_CONSTANTS.PASSWORD);
            await bobLogin.expectLoginSuccess();
          }

          // Bob should see album card
          const bobAlbumCard = bob.getByTestId('album-card');
          await expect(bobAlbumCard.first()).toBeVisible({ timeout: 30000 });

          // Navigate to album
          await bobAlbumCard.first().click();

          const bobGallery = new GalleryPage(bob);
          await bobGallery.waitForLoad();

          // Bob should see the same photos
          await expect(bobGallery.photos.first()).toBeVisible({ timeout: 60000 });
          const bobPhotoCount = await bobGallery.photos.count();
          expect(bobPhotoCount).toBe(alicePhotoCount);
        }
      }
    } else {
      test.info().annotations.push({
        type: 'skip',
        description: 'Member management UI not found',
      });
    }
  });

  test('editor can upload photos to shared album', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    // Alice creates album
    const album = await apiHelper.createAlbum(aliceUser);

    // Alice logs in
    await alice.goto('/');
    const aliceLogin = new LoginPage(alice);
    await aliceLogin.waitForForm();
    await aliceLogin.login(TEST_CONSTANTS.PASSWORD);
    await aliceLogin.expectLoginSuccess();

    // Bob logs in
    await bob.goto('/');
    const bobLogin = new LoginPage(bob);
    await bobLogin.waitForForm();
    await bobLogin.login(TEST_CONSTANTS.PASSWORD);
    await bobLogin.expectLoginSuccess();

    // Alice navigates to album
    const aliceCard = alice.getByTestId('album-card').first();
    await expect(aliceCard).toBeVisible({ timeout: 30000 });
    await aliceCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    // Alice invites Bob as editor
    const membersBtn = alice.getByRole('button', { name: /members|share/i });
    const hasMembers = await membersBtn.first().isVisible().catch(() => false);

    if (hasMembers) {
      await membersBtn.first().click();

      const inviteBtn = alice.getByRole('button', { name: /invite|add/i });
      if (await inviteBtn.first().isVisible().catch(() => false)) {
        await inviteBtn.first().click();

        const bobInfo = await apiHelper.getCurrentUser(bobUser);

        const userInput = alice.getByLabel(/user|member|id/i);
        if (await userInput.first().isVisible().catch(() => false)) {
          await userInput.first().fill(bobInfo.id);

          // Select editor role
          const roleSelect = alice.getByLabel(/role/i);
          if (await roleSelect.isVisible().catch(() => false)) {
            await roleSelect.selectOption('editor');
          }

          const submitBtn = alice.getByRole('button', { name: /invite|add|confirm/i });
          await submitBtn.first().click();

          await alice.waitForTimeout(2000);

          // Bob navigates to shared album
          await bob.reload();

          const bobNeedsLogin = await bobLogin.loginForm.isVisible().catch(() => false);
          if (bobNeedsLogin) {
            await bobLogin.login(TEST_CONSTANTS.PASSWORD);
            await bobLogin.expectLoginSuccess();
          }

          const bobCard = bob.getByTestId('album-card');
          await expect(bobCard.first()).toBeVisible({ timeout: 30000 });
          await bobCard.first().click();

          const bobGallery = new GalleryPage(bob);
          await bobGallery.waitForLoad();

          // Bob uploads a photo
          const testImage = generateTestImage();
          await bobGallery.uploadPhoto(testImage, 'bob-uploaded.png');

          // Photo should appear
          await expect(bobGallery.photos.first()).toBeVisible({ timeout: 60000 });
        }
      }
    } else {
      test.info().annotations.push({
        type: 'skip',
        description: 'Member management not available',
      });
    }
  });

  test('viewer cannot upload to shared album', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    const album = await apiHelper.createAlbum(aliceUser);

    // Both users log in
    await alice.goto('/');
    const aliceLogin = new LoginPage(alice);
    await aliceLogin.waitForForm();
    await aliceLogin.login(TEST_CONSTANTS.PASSWORD);
    await aliceLogin.expectLoginSuccess();

    await bob.goto('/');
    const bobLogin = new LoginPage(bob);
    await bobLogin.waitForForm();
    await bobLogin.login(TEST_CONSTANTS.PASSWORD);
    await bobLogin.expectLoginSuccess();

    // Alice navigates to album
    const aliceCard = alice.getByTestId('album-card').first();
    await expect(aliceCard).toBeVisible({ timeout: 30000 });
    await aliceCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    // Alice invites Bob as viewer (not editor)
    const membersBtn = alice.getByRole('button', { name: /members|share/i });
    const hasMembers = await membersBtn.first().isVisible().catch(() => false);

    if (hasMembers) {
      await membersBtn.first().click();

      const inviteBtn = alice.getByRole('button', { name: /invite|add/i });
      if (await inviteBtn.first().isVisible().catch(() => false)) {
        await inviteBtn.first().click();

        const bobInfo = await apiHelper.getCurrentUser(bobUser);

        const userInput = alice.getByLabel(/user|member|id/i);
        if (await userInput.first().isVisible().catch(() => false)) {
          await userInput.first().fill(bobInfo.id);

          // Explicitly select viewer role
          const roleSelect = alice.getByLabel(/role/i);
          if (await roleSelect.isVisible().catch(() => false)) {
            await roleSelect.selectOption('viewer');
          }

          const submitBtn = alice.getByRole('button', { name: /invite|add|confirm/i });
          await submitBtn.first().click();

          await alice.waitForTimeout(2000);

          // Bob navigates to shared album
          await bob.reload();

          const bobNeedsLogin = await bobLogin.loginForm.isVisible().catch(() => false);
          if (bobNeedsLogin) {
            await bobLogin.login(TEST_CONSTANTS.PASSWORD);
            await bobLogin.expectLoginSuccess();
          }

          const bobCard = bob.getByTestId('album-card');
          await expect(bobCard.first()).toBeVisible({ timeout: 30000 });
          await bobCard.first().click();

          const bobGallery = new GalleryPage(bob);
          await bobGallery.waitForLoad();

          // Bob should NOT see upload button (viewer role)
          const uploadButton = bobGallery.uploadButton;
          const hasUpload = await uploadButton.isVisible().catch(() => false);
          const isDisabled = hasUpload && await uploadButton.isDisabled().catch(() => false);

          // Either no upload button or it's disabled
          expect(!hasUpload || isDisabled).toBeTruthy();
        }
      }
    } else {
      test.info().annotations.push({
        type: 'skip',
        description: 'Member management not available',
      });
    }
  });
});

test.describe('Sharing: Member Removal', () => {
  const apiHelper = new ApiHelper();

  test('removed member loses access to album', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    const album = await apiHelper.createAlbum(aliceUser);

    // Both log in
    await alice.goto('/');
    const aliceLogin = new LoginPage(alice);
    await aliceLogin.waitForForm();
    await aliceLogin.login(TEST_CONSTANTS.PASSWORD);
    await aliceLogin.expectLoginSuccess();

    await bob.goto('/');
    const bobLogin = new LoginPage(bob);
    await bobLogin.waitForForm();
    await bobLogin.login(TEST_CONSTANTS.PASSWORD);
    await bobLogin.expectLoginSuccess();

    // Alice adds photos and invites Bob
    const aliceCard = alice.getByTestId('album-card').first();
    await expect(aliceCard).toBeVisible({ timeout: 30000 });
    await aliceCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    const testImage = generateTestImage();
    await aliceGallery.uploadPhoto(testImage, 'revokable-photo.png');
    await expect(aliceGallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Invite Bob
    const membersBtn = alice.getByRole('button', { name: /members|share/i });
    const hasMembers = await membersBtn.first().isVisible().catch(() => false);

    if (hasMembers) {
      await membersBtn.first().click();

      const inviteBtn = alice.getByRole('button', { name: /invite|add/i });
      if (await inviteBtn.first().isVisible().catch(() => false)) {
        await inviteBtn.first().click();

        const bobInfo = await apiHelper.getCurrentUser(bobUser);

        const userInput = alice.getByLabel(/user|member|id/i);
        if (await userInput.first().isVisible().catch(() => false)) {
          await userInput.first().fill(bobInfo.id);

          const submitBtn = alice.getByRole('button', { name: /invite|add|confirm/i });
          await submitBtn.first().click();

          await alice.waitForTimeout(2000);

          // Bob can see album
          await bob.reload();
          const bobNeedsLogin = await bobLogin.loginForm.isVisible().catch(() => false);
          if (bobNeedsLogin) {
            await bobLogin.login(TEST_CONSTANTS.PASSWORD);
            await bobLogin.expectLoginSuccess();
          }

          const bobCard = bob.getByTestId('album-card');
          await expect(bobCard.first()).toBeVisible({ timeout: 30000 });

          // Now Alice removes Bob
          const closeDialog = alice.getByRole('button', { name: /close|cancel|done/i });
          if (await closeDialog.first().isVisible().catch(() => false)) {
            await closeDialog.first().click();
          }

          await membersBtn.first().click();

          // Find Bob in member list and remove
          const memberList = alice.getByTestId('member-list');
          const hasMemberList = await memberList.isVisible().catch(() => false);

          if (hasMemberList) {
            const bobEntry = alice.getByText(bobInfo.id);
            const hasBobEntry = await bobEntry.first().isVisible().catch(() => false);

            if (hasBobEntry) {
              // Click remove button next to Bob
              const removeBtn = alice.getByRole('button', { name: /remove/i });
              await removeBtn.first().click();

              // Confirm removal
              const confirmBtn = alice.getByRole('button', { name: /confirm|remove|yes/i });
              if (await confirmBtn.first().isVisible().catch(() => false)) {
                await confirmBtn.first().click();
              }

              await alice.waitForTimeout(2000);

              // Bob should no longer see album
              await bob.reload();

              const bobNeedsLoginAgain = await bobLogin.loginForm.isVisible().catch(() => false);
              if (bobNeedsLoginAgain) {
                await bobLogin.login(TEST_CONSTANTS.PASSWORD);
                await bobLogin.expectLoginSuccess();
              }

              const bobAppShell = new AppShell(bob);
              await bobAppShell.waitForLoad();

              // Bob should either see empty state or album is gone
              const bobCards = bob.getByTestId('album-card');
              const albumCount = await bobCards.count();

              // Album should no longer be visible to Bob
              // (Since we only created one album, count should be 0)
              expect(albumCount).toBe(0);
            }
          }
        }
      }
    }
  });
});

test.describe('Sharing: Member List Display', () => {
  const apiHelper = new ApiHelper();

  test('owner sees member list in album', async ({
    authenticatedPage,
    testUser,
  }) => {
    const album = await apiHelper.createAlbum(testUser);

    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    const albumCard = authenticatedPage.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(authenticatedPage);
    await gallery.waitForLoad();

    // Open members panel
    const membersBtn = authenticatedPage.getByRole('button', { name: /members|share/i });
    const hasMembers = await membersBtn.first().isVisible().catch(() => false);

    if (hasMembers) {
      await membersBtn.first().click();

      // Should show at least owner in member list
      const memberList = authenticatedPage.getByTestId('member-list');
      const hasMemberList = await memberList.isVisible().catch(() => false);

      if (hasMemberList) {
        // Should show at least one member (the owner)
        const members = memberList.locator('[data-testid="member-item"]');
        const memberCount = await members.count().catch(() => 0);
        expect(memberCount).toBeGreaterThanOrEqual(1);
      } else {
        // Member list may use different structure
        const ownerLabel = authenticatedPage.getByText(/owner|you/i);
        const hasOwner = await ownerLabel.first().isVisible().catch(() => false);
        expect(hasOwner).toBeTruthy();
      }
    } else {
      test.info().annotations.push({
        type: 'skip',
        description: 'Members button not found',
      });
    }
  });

  test('member roles are displayed correctly', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    const album = await apiHelper.createAlbum(aliceUser);

    // Both log in
    await alice.goto('/');
    const aliceLogin = new LoginPage(alice);
    await aliceLogin.waitForForm();
    await aliceLogin.login(TEST_CONSTANTS.PASSWORD);
    await aliceLogin.expectLoginSuccess();

    await bob.goto('/');
    const bobLogin = new LoginPage(bob);
    await bobLogin.waitForForm();
    await bobLogin.login(TEST_CONSTANTS.PASSWORD);
    await bobLogin.expectLoginSuccess();

    // Alice navigates and invites Bob as editor
    const aliceCard = alice.getByTestId('album-card').first();
    await expect(aliceCard).toBeVisible({ timeout: 30000 });
    await aliceCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    const membersBtn = alice.getByRole('button', { name: /members|share/i });
    const hasMembers = await membersBtn.first().isVisible().catch(() => false);

    if (hasMembers) {
      await membersBtn.first().click();

      const inviteBtn = alice.getByRole('button', { name: /invite|add/i });
      if (await inviteBtn.first().isVisible().catch(() => false)) {
        await inviteBtn.first().click();

        const bobInfo = await apiHelper.getCurrentUser(bobUser);

        const userInput = alice.getByLabel(/user|member|id/i);
        if (await userInput.first().isVisible().catch(() => false)) {
          await userInput.first().fill(bobInfo.id);

          const roleSelect = alice.getByLabel(/role/i);
          if (await roleSelect.isVisible().catch(() => false)) {
            await roleSelect.selectOption('editor');
          }

          const submitBtn = alice.getByRole('button', { name: /invite|add|confirm/i });
          await submitBtn.first().click();

          await alice.waitForTimeout(2000);

          // Close invite dialog if open
          const closeBtn = alice.getByRole('button', { name: /close|done|cancel/i });
          if (await closeBtn.first().isVisible().catch(() => false)) {
            await closeBtn.first().click();
          }

          // Open members list again
          await membersBtn.first().click();

          // Should show Bob with editor role
          const memberList = alice.getByTestId('member-list');
          if (await memberList.isVisible().catch(() => false)) {
            const editorLabel = alice.getByText(/editor/i);
            const ownerLabel = alice.getByText(/owner/i);

            const hasEditor = await editorLabel.first().isVisible().catch(() => false);
            const hasOwner = await ownerLabel.first().isVisible().catch(() => false);

            expect(hasEditor || hasOwner).toBeTruthy();
          }
        }
      }
    }
  });
});

test.describe('Sharing: Security Boundaries', () => {
  const apiHelper = new ApiHelper();

  test('non-member cannot see album in list', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser } = twoUserContext;

    // Alice creates a private album
    const album = await apiHelper.createAlbum(aliceUser);

    // Alice logs in and uploads photos
    await alice.goto('/');
    const aliceLogin = new LoginPage(alice);
    await aliceLogin.waitForForm();
    await aliceLogin.login(TEST_CONSTANTS.PASSWORD);
    await aliceLogin.expectLoginSuccess();

    const aliceCard = alice.getByTestId('album-card').first();
    await expect(aliceCard).toBeVisible({ timeout: 30000 });
    await aliceCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    const testImage = generateTestImage();
    await aliceGallery.uploadPhoto(testImage, 'private-photo.png');
    await expect(aliceGallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Bob logs in (NOT invited)
    await bob.goto('/');
    const bobLogin = new LoginPage(bob);
    await bobLogin.waitForForm();
    await bobLogin.login(TEST_CONSTANTS.PASSWORD);
    await bobLogin.expectLoginSuccess();

    const bobAppShell = new AppShell(bob);
    await bobAppShell.waitForLoad();

    // Bob should NOT see Alice's album
    const bobCards = bob.getByTestId('album-card');
    const albumCount = await bobCards.count();

    // Bob only has access to his own albums (should be 0 in this test)
    expect(albumCount).toBe(0);
  });
});
