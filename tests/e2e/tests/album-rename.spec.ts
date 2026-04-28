/**
 * Album Rename E2E Tests
 *
 * Tests for album rename functionality with encrypted name handling.
 * Verifies UI, encryption, and permission enforcement.
 */

import {
    AppShell,
    createAlbumViaAPI,
    expect,
    GalleryPage,
    LoginPage,
    loginUser,
    RenameAlbumDialog,
    test,
    TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Album Rename @p1 @album', () => {
  test.describe('Rename Dialog UI', () => {
    test('P1-RENAME-1: rename button visible for album owner', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');

      // Login FIRST to register user with proper crypto
      await loginUser(user, TEST_PASSWORD);

      // Now create album via API (faster setup, user already exists with proper auth)
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Reload to see the album (since we created it after login)
      await user.page.reload();
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      // Navigate to album
      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      // Rename button should be visible in the album settings menu
      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();
      await gallery.openAlbumSettings();
      await expect(gallery.renameAlbumButton).toBeVisible({ timeout: 5000 });
    });

    test('P1-RENAME-2: clicking rename opens dialog with current name', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');
      const albumName = testContext.generateAlbumName('My Photos');

      // Create album via UI to ensure encrypted name is set
      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();
      const createDialog = user.page.getByTestId('create-album-dialog');
      await expect(createDialog).toBeVisible({ timeout: 5000 });
      await user.page.getByTestId('album-name-input').fill(albumName);
      await user.page.getByTestId('create-button').click();

      // Wait for album to appear
      await expect(user.page.getByTestId('album-card').filter({ hasText: albumName })).toBeVisible({
        timeout: 15000,
      });

      // Navigate to album
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      // Open rename dialog using retry pattern to handle menu detachment
      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();

      // Input should contain current name
      const inputValue = await renameDialog.getName();
      expect(inputValue).toBe(albumName);
    });

    test('P1-RENAME-3: cancel closes dialog without renaming', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');
      const albumName = testContext.generateAlbumName('Original Name');

      // Create album
      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();
      await user.page.getByTestId('album-name-input').fill(albumName);
      await user.page.getByTestId('create-button').click();

      await expect(user.page.getByTestId('album-card').filter({ hasText: albumName })).toBeVisible({
        timeout: 15000,
      });

      // Navigate to album
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      // Open rename dialog using retry pattern to handle menu detachment
      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();
      await renameDialog.setName('Changed Name That Should Not Save');
      await renameDialog.cancel();

      // Dialog should close
      await renameDialog.waitForClose();

      // Go back to album list
      await appShell.goBack();

      // Album should still have original name
      await expect(user.page.getByTestId('album-card').filter({ hasText: albumName })).toBeVisible({
        timeout: 10000,
      });
    });

    test('P1-RENAME-4: save button disabled when name unchanged', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');

      // Login FIRST to register user with proper crypto
      await loginUser(user, TEST_PASSWORD);

      // Now create album via API (faster setup, user already exists with proper auth)
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Reload to see the album (since we created it after login)
      await user.page.reload();
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();

      // Save button should be disabled initially (name unchanged)
      await renameDialog.expectSaveDisabled();

      // Cancel
      await renameDialog.cancel();
    });

    test('P1-RENAME-5: save button enabled when name changed', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');

      // Login FIRST to register user with proper crypto
      await loginUser(user, TEST_PASSWORD);

      // Now create album via API (faster setup, user already exists with proper auth)
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Reload to see the album (since we created it after login)
      await user.page.reload();
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();

      // Change name
      await renameDialog.setName('New Album Name');

      // Save button should be enabled
      await renameDialog.expectSaveEnabled();

      // Cancel
      await renameDialog.cancel();
    });
  });

  test.describe('Successful Rename', () => {
    test('P1-RENAME-6: rename album updates name in gallery', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');
      const originalName = testContext.generateAlbumName('Original');
      const newName = testContext.generateAlbumName('Renamed');

      // Create album with known name
      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();
      await user.page.getByTestId('album-name-input').fill(originalName);
      await user.page.getByTestId('create-button').click();

      await expect(user.page.getByTestId('album-card').filter({ hasText: originalName })).toBeVisible({
        timeout: 15000,
      });

      // Navigate to album
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      // Rename using retry pattern to handle menu detachment
      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();
      await renameDialog.rename(newName);

      // Go back to album list
      await appShell.goBack();

      // New name should appear
      await expect(user.page.getByTestId('album-card').filter({ hasText: newName })).toBeVisible({
        timeout: 10000,
      });

      // Old name should not appear
      await expect(user.page.getByTestId('album-card').filter({ hasText: originalName })).not.toBeVisible();
    });

    test('P1-RENAME-7: renamed album persists after page reload', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');
      const originalName = testContext.generateAlbumName('Before Reload');
      const newName = testContext.generateAlbumName('After Rename');

      // Create album
      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();
      await user.page.getByTestId('album-name-input').fill(originalName);
      await user.page.getByTestId('create-button').click();

      await expect(user.page.getByTestId('album-card').filter({ hasText: originalName })).toBeVisible({
        timeout: 15000,
      });

      // Navigate and rename
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      // Open rename dialog using retry pattern
      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();
      await renameDialog.rename(newName);

      // Reload page
      await user.page.reload();

      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      // After reload, we're inside the album - navigate back to albums list
      const appShellAfterReload = new AppShell(user.page);
      await appShellAfterReload.goBack();

      // New name should still appear
      await expect(user.page.getByTestId('album-card').filter({ hasText: newName })).toBeVisible({
        timeout: 15000,
      });
    });
  });

  test.describe('Validation', () => {
    test('P1-RENAME-8: empty name shows error or disables save', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('owner');

      // Login FIRST to register user with proper crypto
      await loginUser(user, TEST_PASSWORD);

      // Now create album via API (faster setup, user already exists with proper auth)
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      // Reload to see the album (since we created it after login)
      await user.page.reload();
      const loginPage = new LoginPage(user.page);
      await loginPage.unlockAfterReload(TEST_PASSWORD, user.email);

      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      await gallery.openRenameDialog();

      const renameDialog = new RenameAlbumDialog(user.page);
      await renameDialog.waitForOpen();

      // Clear the name
      await renameDialog.setName('');

      // Either error should show or save should be disabled
      const isDisabled = await renameDialog.saveButton.isDisabled();
      if (!isDisabled) {
        await renameDialog.save();
        await renameDialog.expectError(/required/i);
      } else {
        expect(isDisabled).toBeTruthy();
      }

      // Cancel
      await user.page.keyboard.press('Escape');
    });
  });
});
