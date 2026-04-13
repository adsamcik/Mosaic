/**
 * Photo Selection & Bulk Actions E2E Tests
 *
 * Tests for multi-select mode, selection controls, and bulk operations
 * (select all, clear, delete, keyboard shortcuts).
 */

import {
  createAlbumViaUI,
  expect,
  GalleryPage,
  generateTestImage,
  loginUser,
  test,
  TEST_PASSWORD,
  TestContext,
} from '../fixtures-enhanced';

/** Helper: set up an album with uploaded photos and return the gallery page object. */
async function setupAlbumWithPhotos(
  testContext: TestContext,
  userPrefix: string,
  photoCount: number,
){
  const user = await testContext.createAuthenticatedUser(userPrefix);
  await loginUser(user, TEST_PASSWORD);

  const albumName = testContext.generateAlbumName('Selection');
  await createAlbumViaUI(user.page, albumName);

  const gallery = new GalleryPage(user.page);
  const testImage = generateTestImage('tiny');

  for (let i = 1; i <= photoCount; i++) {
    await gallery.uploadPhoto(testImage, testContext.generatePhotoName(i));
  }

  await gallery.waitForSync();
  await gallery.expectPhotoCount(photoCount);

  return { user, gallery };
}

test.describe('Photo Selection @p1 @photo @ui', () => {
  test('enter selection mode via button', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-enter', 2);
    const page = user.page;

    // Click the selection-mode button
    await page.getByTestId('selection-mode-button').click();

    // The floating action bar should appear
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });
  });

  test('select a photo in selection mode', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-one', 2);
    const page = user.page;

    // Enter selection mode
    await page.getByTestId('selection-mode-button').click();
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });

    // Click the first photo thumbnail to select it
    const photos = gallery.getPhotos();
    await photos.first().click();

    // Selection count should update to 1
    await expect(page.locator('.selection-count-number')).toHaveText('1', { timeout: 5000 });
  });

  test('select multiple photos', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-multi', 3);
    const page = user.page;

    // Enter selection mode
    await page.getByTestId('selection-mode-button').click();
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });

    // Click first two photos
    const photos = await gallery.getPhotos().all();
    await photos[0].click();
    await photos[1].click();

    // Selection count should be 2
    await expect(page.locator('.selection-count-number')).toHaveText('2', { timeout: 5000 });
  });

  test('select all via action bar button', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-all', 3);
    const page = user.page;

    // Enter selection mode
    await page.getByTestId('selection-mode-button').click();
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });

    // Click select all
    await page.getByTestId('action-bar-select-all').click();

    // All 3 photos should be selected
    await expect(page.locator('.selection-count-number')).toHaveText('3', { timeout: 5000 });
  });

  test('clear selection', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-clear', 3);
    const page = user.page;

    // Enter selection mode and select a photo
    await page.getByTestId('selection-mode-button').click();
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });

    const photos = await gallery.getPhotos().all();
    await photos[0].click();
    await photos[1].click();
    await expect(page.locator('.selection-count-number')).toHaveText('2', { timeout: 5000 });

    // Click clear button (visible when some but not all are selected)
    await page.getByTestId('action-bar-clear').click();

    // Count should reset to 0
    await expect(page.locator('.selection-count-number')).toHaveText('0', { timeout: 5000 });
  });

  test('exit selection mode via exit button', async ({ testContext }) => {
    const { user } = await setupAlbumWithPhotos(testContext, 'sel-exit-btn', 2);
    const page = user.page;

    // Enter selection mode
    await page.getByTestId('selection-mode-button').click();
    const actionBar = page.getByTestId('selection-action-bar');
    await expect(actionBar).toBeVisible({ timeout: 5000 });

    // Click exit button on the action bar
    await page.getByTestId('action-bar-exit').click();

    // Action bar should disappear
    await expect(actionBar).toBeHidden({ timeout: 5000 });
  });

  test('exit selection mode via Escape key', async ({ testContext }) => {
    const { user } = await setupAlbumWithPhotos(testContext, 'sel-exit-esc', 2);
    const page = user.page;

    // Enter selection mode
    await page.getByTestId('selection-mode-button').click();
    const actionBar = page.getByTestId('selection-action-bar');
    await expect(actionBar).toBeVisible({ timeout: 5000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Action bar should disappear
    await expect(actionBar).toBeHidden({ timeout: 5000 });
  });

  test('bulk delete selected photos', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-del', 3);
    const page = user.page;

    // Enter selection mode
    await page.getByTestId('selection-mode-button').click();
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });

    // Select first two photos
    const photos = await gallery.getPhotos().all();
    await photos[0].click();
    await photos[1].click();
    await expect(page.locator('.selection-count-number')).toHaveText('2', { timeout: 5000 });

    // Click delete button on the action bar
    await page.getByTestId('action-bar-delete').click();

    // Confirm deletion in the dialog
    const deleteDialog = page.getByTestId('delete-photo-dialog');
    await expect(deleteDialog).toBeVisible({ timeout: 5000 });
    await page.getByTestId('delete-confirm-button').click();

    // Dialog should close and only 1 photo should remain
    await expect(deleteDialog).toBeHidden({ timeout: 15000 });
    await gallery.expectPhotoCount(1, 30000);
  });

  test('select all with Ctrl+A keyboard shortcut', async ({ testContext }) => {
    const { user, gallery } = await setupAlbumWithPhotos(testContext, 'sel-ctrl-a', 3);
    const page = user.page;

    // Enter selection mode first (keyboard shortcuts only work in selection mode)
    await page.getByTestId('selection-mode-button').click();
    await expect(page.getByTestId('selection-action-bar')).toBeVisible({ timeout: 5000 });

    // Press Ctrl+A to select all
    await page.keyboard.press('Control+a');

    // All 3 photos should be selected
    await expect(page.locator('.selection-count-number')).toHaveText('3', { timeout: 5000 });
  });
});
