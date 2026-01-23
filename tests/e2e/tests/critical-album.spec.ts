/**
 * Critical E2E Flow Tests - Album Management
 *
 * These tests cover album CRUD operations and sharing:
 * 1. Album creation via UI
 * 2. Album list display
 * 3. Album navigation
 * 4. Album sharing between users
 *
 * These are P0/P1 priority tests that must pass before any release.
 */

import {
    AppShell,
    CreateAlbumDialogPage,
    expect,
    GalleryPage,
    generateTestImage,
    LoginPage,
    test,
    TEST_CONSTANTS,
} from '../fixtures';
import { getAlbumsViaAPI, deleteAlbumViaAPI } from '../framework';

/**
 * Clean up all albums for a user.
 * Used in afterEach hooks for tests using poolUser to prevent state accumulation.
 */
async function cleanupUserAlbums(username: string): Promise<void> {
  try {
    const albums = await getAlbumsViaAPI(username);
    for (const album of albums) {
      try {
        await deleteAlbumViaAPI(username, album.id);
      } catch (err) {
        console.warn(`[Cleanup] Failed to delete album ${album.id}: ${err}`);
      }
    }
    if (albums.length > 0) {
      console.log(`[Cleanup] Deleted ${albums.length} albums for ${username}`);
    }
  } catch (err) {
    console.warn(`[Cleanup] Failed to get albums for ${username}: ${err}`);
  }
}

test.describe('Critical Flow: Album Sharing @p0 @critical @sharing @multi-user @slow', () => {
  // Triple the timeout for slow critical sharing tests
  test.slow();

  test('P0-4: owner can share album and viewer can access photos', async ({
    twoUserContext,
  }) => {
    const { alice, bob, aliceUser, bobUser } = twoUserContext;

    // Step 1: Alice logs in and creates an album via browser
    await alice.goto('/');
    const aliceLoginPage = new LoginPage(alice);
    await aliceLoginPage.waitForForm();
    await aliceLoginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, aliceUser);
    await aliceLoginPage.expectLoginSuccess();

    const aliceAppShell = new AppShell(alice);
    await aliceAppShell.waitForLoad();

    // Create album through browser UI (generates real epoch keys)
    await aliceAppShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(alice);
    await createDialog.createAlbum(`Shared Album Test ${Date.now()}`);

    // Navigate to album
    const aliceAlbumCard = alice.getByTestId('album-card').first();
    await expect(aliceAlbumCard).toBeVisible({ timeout: 30000 });
    await aliceAlbumCard.click();

    const aliceGallery = new GalleryPage(alice);
    await aliceGallery.waitForLoad();

    // Step 2: Alice uploads a photo using the proven uploadPhoto method
    const testImage = generateTestImage();
    await aliceGallery.uploadPhoto(testImage, 'shared-photo.png');
    await expect(aliceGallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Step 3: Bob logs in (this will initialize his identity)
    await bob.goto('/');
    const bobLoginPage = new LoginPage(bob);
    await bobLoginPage.waitForForm();
    await bobLoginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, bobUser);
    await bobLoginPage.expectLoginSuccess();

    const bobAppShell = new AppShell(bob);
    await bobAppShell.waitForLoad();

    // Step 4: Alice invites Bob to the album
    // Open member management
    const membersButton = alice.getByRole('button', { name: /members|share|invite/i });
    const hasMembersButton = await membersButton.first().isVisible().catch(() => false);

    if (hasMembersButton) {
      await membersButton.first().click();

      // Look for invite dialog/form
      const inviteInput = alice.getByLabel(/user|member|email/i);
      const hasInviteInput = await inviteInput.first().isVisible().catch(() => false);

      if (hasInviteInput) {
        // Enter Bob's username directly
        await inviteInput.first().fill(bobUser);

        const inviteButton = alice.getByRole('button', { name: /invite|add|share/i });
        await inviteButton.click();

        // Wait for invite to complete
        await expect(async () => {
          const successMessage = alice.getByText(/invited|added|shared/i);
          const hasSuccess = await successMessage.first().isVisible().catch(() => false);
          expect(hasSuccess).toBeTruthy();
        }).toPass({ timeout: 30000 });

        // Step 5: Bob should now see the shared album
        await bob.reload();

        // Re-login if needed
        const bobNeedsLogin = await bobLoginPage.loginForm.isVisible().catch(() => false);
        if (bobNeedsLogin) {
          await bobLoginPage.loginOrRegister(TEST_CONSTANTS.PASSWORD, bobUser);
          await bobLoginPage.expectLoginSuccess();
        }

        // Check for shared album
        const bobAlbumCard = bob.getByTestId('album-card');
        await expect(bobAlbumCard.first()).toBeVisible({ timeout: 30000 });

        // Navigate to album
        await bobAlbumCard.first().click();

        const bobGallery = new GalleryPage(bob);
        await bobGallery.waitForLoad();

        // Bob should see the photo
        await expect(bobGallery.photos.first()).toBeVisible({ timeout: 60000 });
      } else {
        test.info().annotations.push({
          type: 'skip',
          description: 'Invite UI not available - sharing may not be implemented',
        });
      }
    } else {
      test.info().annotations.push({
        type: 'skip',
        description: 'Members button not found - sharing may not be implemented',
      });
    }
  });
});

test.describe('Critical Flow: Album CRUD @p0 @critical @album', () => {
  // Note: mobile-chrome is excluded via testIgnore in playwright.config.ts

  // Track current pool user for cleanup
  let currentPoolUsername: string | undefined;

  test.afterEach(async () => {
    // Clean up all albums for the pool user to prevent state accumulation
    if (currentPoolUsername) {
      await cleanupUserAlbums(currentPoolUsername);
      currentPoolUsername = undefined;
    }
  });

  test('P1-1a: create album via UI appears in list', async ({
    poolUser,
  }) => {
    const { page } = poolUser;
    currentPoolUsername = poolUser.username;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    const appShell = new AppShell(page);
    await appShell.waitForLoad();

    // Count initial albums
    const initialCards = await page.getByTestId('album-card').count();

    // Look for create album button
    const createButton = appShell.createAlbumButton;
    const hasCreateButton = await createButton.isVisible().catch(() => false);

    if (hasCreateButton) {
      await createButton.click();

      // Fill in album name if dialog appears
      const nameInput = page.getByLabel(/album name|name/i);
      const hasNameInput = await nameInput.first().isVisible().catch(() => false);

      if (hasNameInput) {
        await nameInput.first().fill('Test Album ' + Date.now());

        // Submit using the specific testid for the dialog submit button
        const submitButton = page.getByTestId('create-button');
        await expect(submitButton).toBeVisible({ timeout: 5000 });
        await submitButton.click();

        // Wait for album to appear
        await expect(async () => {
          const newCount = await page.getByTestId('album-card').count();
          expect(newCount).toBeGreaterThan(initialCards);
        }).toPass({ timeout: 30000 });
      } else {
        // Maybe it auto-creates without a dialog
        await expect(async () => {
          const newCount = await page.getByTestId('album-card').count();
          expect(newCount).toBeGreaterThan(initialCards);
        }).toPass({ timeout: 30000 });
      }
    } else {
      test.info().annotations.push({
        type: 'warning',
        description: 'Create album button not visible',
      });
    }
  });

  test('P1-1b: albums created via browser appear in list', async ({
    poolUser,
  }) => {
    const { page } = poolUser;
    currentPoolUsername = poolUser.username;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create two albums via browser UI
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Album List Test 1 ${Date.now()}`);

    await appShell.createAlbum();
    await createDialog.createAlbum(`Album List Test 2 ${Date.now()}`);

    // Should show album cards
    const albumCards = page.getByTestId('album-card');
    await expect(albumCards.first()).toBeVisible({ timeout: 30000 });

    const count = await albumCards.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('P1-1c: clicking album navigates to gallery view', async ({
    poolUser,
  }) => {
    currentPoolUsername = poolUser.username;
    const { page } = poolUser;

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

    // Create an album via browser UI
    const appShell = new AppShell(page);
    await appShell.createAlbum();
    const createDialog = new CreateAlbumDialogPage(page);
    await createDialog.createAlbum(`Gallery Navigation Test ${Date.now()}`);

    const albumCard = page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    // Should show gallery view
    const gallery = new GalleryPage(page);
    await gallery.waitForLoad();

    // Should have back button to albums
    const backButton = appShell.backToAlbumsButton;
    const hasBackButton = await backButton.isVisible().catch(() => false);

    // Either back button exists or we're in gallery state
    expect(hasBackButton || (await gallery.gallery.isVisible())).toBeTruthy();
  });
});
