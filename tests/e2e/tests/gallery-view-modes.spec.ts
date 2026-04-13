/**
 * Gallery View Modes E2E Tests
 *
 * Tests for switching between justified, grid, mosaic, story, and map views.
 * Verifies view toggle buttons, active states, and layout rendering.
 */

import {
  AppShell,
  createAlbumViaUI,
  expect,
  GalleryPage,
  generateTestImage,
  loginUser,
  test,
  TEST_PASSWORD,
} from '../fixtures-enhanced';

test.describe('Gallery View Modes @p1 @gallery @ui', () => {
  test('view mode toggle buttons are visible', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-btns');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewBtns');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Justified, grid, mosaic, and story toggles should always be visible
    await expect(gallery.viewJustifiedButton).toBeVisible({ timeout: 10000 });
    await expect(gallery.viewGridButton).toBeVisible();
    await expect(user.page.getByTestId('view-toggle-mosaic')).toBeVisible();
    await expect(user.page.getByTestId('view-toggle-story')).toBeVisible();

    // Map button is only visible when geotagged photos exist, so it may not appear here
  });

  test('default view mode displays photos', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-default');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewDefault');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Upload a photo
    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'default-view.png');

    // Default mode is justified — photos should be visible
    await gallery.expectPhotoCount(1);
    await expect(gallery.getPhotos().first()).toBeVisible();

    // The justified button should be active (aria-pressed)
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('switch to grid view', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-grid');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewGrid');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Upload a photo so the grid has content
    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'grid-view.png');
    await gallery.expectPhotoCount(1);

    // Switch to grid view
    await gallery.setViewMode('grid');

    // Grid view renders with data-testid="photo-grid"
    await expect(user.page.getByTestId('photo-grid')).toBeVisible({ timeout: 10000 });

    // Grid button should now be active
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'true');

    // Justified button should no longer be active
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'false');
  });

  test('switch to justified view', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-just');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewJustified');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Upload a photo
    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'justified-view.png');
    await gallery.expectPhotoCount(1);

    // First switch to grid to move away from justified
    await gallery.setViewMode('grid');
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'true');

    // Now switch back to justified
    await gallery.setViewMode('justified');

    // Justified view uses PhotoGrid which also renders data-testid="photo-grid"
    // but the justified button should be active
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'true');
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'false');

    // Photos should still be visible
    await expect(gallery.getPhotos().first()).toBeVisible({ timeout: 10000 });
  });

  test('switch to mosaic view', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-mosaic');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewMosaic');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Upload a photo
    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'mosaic-view.png');
    await gallery.expectPhotoCount(1);

    // Switch to mosaic view
    const mosaicButton = user.page.getByTestId('view-toggle-mosaic');
    await mosaicButton.click();

    // Mosaic view renders with data-testid="mosaic-photo-grid"
    await expect(user.page.getByTestId('mosaic-photo-grid')).toBeVisible({ timeout: 10000 });

    // Mosaic button should be active
    await expect(mosaicButton).toHaveAttribute('aria-pressed', 'true');

    // Other view buttons should be inactive
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'false');
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'false');
  });

  test('switch to map view (only visible with geotagged photos)', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-map');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewMap');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Without geotagged photos, the map button should NOT be visible
    // (map button is conditionally rendered based on geotaggedCount > 0)
    await expect(gallery.viewMapButton).toBeHidden({ timeout: 5000 });
  });

  test('switch back from grid to justified', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-switch');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewSwitch');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Upload photos
    const testImage = generateTestImage('tiny');
    await gallery.uploadPhoto(testImage, 'switch-view.png');
    await gallery.expectPhotoCount(1);

    // Switch to grid
    await gallery.setViewMode('grid');
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'true');

    // Switch back to justified
    await gallery.setViewMode('justified');
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'true');

    // Photos should be visible again in justified layout
    await expect(gallery.getPhotos().first()).toBeVisible({ timeout: 10000 });
  });

  test('view mode buttons show active state', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-active');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewActive');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);
    const mosaicButton = user.page.getByTestId('view-toggle-mosaic');
    const storyButton = user.page.getByTestId('view-toggle-story');

    // Default: justified is active
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'true');
    await expect(gallery.viewJustifiedButton).toHaveClass(/view-toggle-btn--active/);

    // Switch to grid: grid becomes active, justified deactivates
    await gallery.setViewMode('grid');
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'true');
    await expect(gallery.viewGridButton).toHaveClass(/view-toggle-btn--active/);
    await expect(gallery.viewJustifiedButton).toHaveAttribute('aria-pressed', 'false');
    await expect(gallery.viewJustifiedButton).not.toHaveClass(/view-toggle-btn--active/);

    // Switch to mosaic: mosaic becomes active, grid deactivates
    await mosaicButton.click();
    await expect(mosaicButton).toHaveAttribute('aria-pressed', 'true');
    await expect(mosaicButton).toHaveClass(/view-toggle-btn--active/);
    await expect(gallery.viewGridButton).toHaveAttribute('aria-pressed', 'false');

    // Switch to story: story becomes active, mosaic deactivates
    await storyButton.click();
    await expect(storyButton).toHaveAttribute('aria-pressed', 'true');
    await expect(storyButton).toHaveClass(/view-toggle-btn--active/);
    await expect(mosaicButton).toHaveAttribute('aria-pressed', 'false');
  });

  test('empty gallery shows empty state in different views', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('view-empty');
    await loginUser(user, TEST_PASSWORD);

    const albumName = testContext.generateAlbumName('ViewEmpty');
    await createAlbumViaUI(user.page, albumName);

    const gallery = new GalleryPage(user.page);

    // Default justified view — should show empty state
    await gallery.expectEmptyState();

    // Switch to grid — should also show empty state
    await gallery.setViewMode('grid');
    const gridEmpty = user.page.locator('.photo-grid-empty');
    await expect(gridEmpty).toBeVisible({ timeout: 10000 });

    // Switch back to justified — empty state should return
    await gallery.setViewMode('justified');
    await gallery.expectEmptyState();
  });
});
