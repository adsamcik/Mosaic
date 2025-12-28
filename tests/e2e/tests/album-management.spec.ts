/**
 * Album Management E2E Tests
 *
 * Comprehensive tests for album CRUD operations using the parallel-safe framework.
 * Each test is fully isolated with unique users and automatic cleanup.
 */

import {
  test,
  expect,
  LoginPage,
  AppShell,
  CreateAlbumDialog,
  GalleryPage,
  loginUser,
  createAlbumViaAPI,
  TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Album Management', () => {
  test.describe('Album Creation', () => {
    test('P1-ALBUM-1: create album via UI with valid name', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('creator');
      const albumName = testContext.generateAlbumName('My Photos');

      // Login
      await loginUser(user, TEST_PASSWORD);

      // Open create album dialog
      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();

      // Create album
      const dialog = new CreateAlbumDialog(user.page);
      await dialog.createAlbum(albumName);

      // Verify album appears in list
      await expect(user.page.getByTestId('album-card').filter({ hasText: albumName })).toBeVisible({
        timeout: 10000,
      });
    });

    test('P1-ALBUM-2: create album shows error for empty name', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('creator');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();

      const dialog = new CreateAlbumDialog(user.page);
      await dialog.waitForOpen();
      await dialog.setName('');
      await dialog.submit();

      // Should show error or button should be disabled
      const hasError = await dialog.errorMessage.isVisible().catch(() => false);
      const isDisabled = await dialog.createButton.isDisabled();
      expect(hasError || isDisabled).toBeTruthy();
    });

    test('P1-ALBUM-3: cancel create album closes dialog without creating', async ({
      testContext,
    }) => {
      const user = await testContext.createAuthenticatedUser('creator');
      const albumName = testContext.generateAlbumName('Cancelled');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      const initialCount = await appShell.getAlbumCards().then((cards) => cards.length);

      await appShell.openCreateAlbumDialog();

      const dialog = new CreateAlbumDialog(user.page);
      await dialog.waitForOpen();
      await dialog.setName(albumName);
      await dialog.cancel();

      // Dialog should close
      await dialog.waitForClose();

      // Album count should not change
      const finalCount = await appShell.getAlbumCards().then((cards) => cards.length);
      expect(finalCount).toBe(initialCount);
    });

    test('P1-ALBUM-4: multiple albums can be created sequentially', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('multi-creator');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      const dialog = new CreateAlbumDialog(user.page);

      // Create first album
      const album1 = testContext.generateAlbumName('First');
      await appShell.openCreateAlbumDialog();
      await dialog.createAlbum(album1);

      // Create second album
      const album2 = testContext.generateAlbumName('Second');
      await appShell.openCreateAlbumDialog();
      await dialog.createAlbum(album2);

      // Create third album
      const album3 = testContext.generateAlbumName('Third');
      await appShell.openCreateAlbumDialog();
      await dialog.createAlbum(album3);

      // All three should be visible
      await expect(user.page.getByTestId('album-card')).toHaveCount(3, { timeout: 10000 });
    });
  });

  test.describe('Album Navigation', () => {
    test('P1-ALBUM-5: clicking album card opens gallery view', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('navigator');

      // Create album via API for faster setup
      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      await loginUser(user, TEST_PASSWORD);

      // Click on album
      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      // Should show gallery
      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();
      await expect(gallery.gallery).toBeVisible();
    });

    test('P1-ALBUM-6: back button returns to album list', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('navigator');

      const albumResult = await createAlbumViaAPI(user.email);
      testContext.trackAlbum(albumResult.id, user.email);

      await loginUser(user, TEST_PASSWORD);

      // Navigate to album
      const appShell = new AppShell(user.page);
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
      await appShell.clickAlbum(0);

      const gallery = new GalleryPage(user.page);
      await gallery.waitForLoad();

      // Go back
      await appShell.goBack();

      // Should show album list again
      await expect(user.page.getByTestId('album-card')).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Album List Display', () => {
    test('P1-ALBUM-7: empty state shown when no albums', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('empty-user');

      await loginUser(user, TEST_PASSWORD);

      const appShell = new AppShell(user.page);
      await appShell.expectEmptyState();
    });

    test('P1-ALBUM-8: albums persist across page reload', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('persist-user');

      await loginUser(user, TEST_PASSWORD);

      // Create album
      const albumName = testContext.generateAlbumName('Persistent');
      const appShell = new AppShell(user.page);
      await appShell.openCreateAlbumDialog();

      const dialog = new CreateAlbumDialog(user.page);
      await dialog.createAlbum(albumName);

      // Wait for album to appear
      await expect(user.page.getByTestId('album-card').filter({ hasText: albumName })).toBeVisible({
        timeout: 10000,
      });

      // Reload page
      await user.page.reload();

      // Re-login
      const loginPage = new LoginPage(user.page);
      await loginPage.waitForForm();
      await loginPage.login(TEST_PASSWORD);
      await loginPage.expectLoginSuccess();

      // Album should still be there
      await expect(user.page.getByTestId('album-card').filter({ hasText: albumName })).toBeVisible({
        timeout: 10000,
      });
    });
  });
});
