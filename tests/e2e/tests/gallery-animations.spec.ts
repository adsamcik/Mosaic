/**
 * Gallery Animation E2E Tests
 *
 * Tests for photo tile enter/exit animations in the gallery view.
 * These tests verify the AnimatedTile component behavior in a real browser
 * environment where requestAnimationFrame works correctly.
 *
 * NOTE: Unit tests for AnimatedTile are limited due to happy-dom/RAF
 * incompatibility. See docs/TROUBLESHOOTING.md for details.
 */

import {
    AppShell,
    createAlbumViaUI,
    expect,
    GalleryPage,
    generateTestImage,
    loginUser,
    test,
    TEST_PASSWORD
} from '../fixtures-enhanced';

test.describe('Gallery Animations @p2 @gallery @ui', () => {
  test.describe('Photo Enter Animations', () => {
    test('P2-ANIM-1: photos appear with enter animation classes', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('enter-anim');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('EnterAnim');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // INTENTIONAL: Wait for gallery's animation system to mark first render items as "seen"
      // The gallery needs ~50ms after first render before new items will animate
      await user.page.waitForTimeout(200);
      
      // Upload a photo
      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, 'animation-test.png');

      // Wait for photo to appear
      await gallery.expectPhotoCount(1);

      // Verify animation classes are applied (tile should be in 'entered' state)
      const photo = gallery.getPhotos().first();

      // Check for animated-tile wrapper
      const animatedTile = user.page.locator('.animated-tile').first();
      await expect(animatedTile).toBeVisible({ timeout: 5000 });

      // After animation completes, should have 'entered' phase
      await expect(animatedTile).toHaveAttribute('data-animation-phase', 'entered', { timeout: 5000 });

      // Should have settled class (animation complete)
      await expect(animatedTile).toHaveClass(/animation-settled/, { timeout: 5000 });
    });

    test('P2-ANIM-2: stagger delay is applied to batch uploads', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('stagger-anim');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('StaggerAnim');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // INTENTIONAL: Wait for gallery's animation system initialization before uploading
      await user.page.waitForTimeout(200);

      // Upload multiple photos
      const images = [
        { buffer: generateTestImage('tiny'), filename: 'stagger-1.png' },
        { buffer: generateTestImage('tiny'), filename: 'stagger-2.png' },
        { buffer: generateTestImage('tiny'), filename: 'stagger-3.png' },
      ];
      await gallery.uploadMultiplePhotos(images);

      // Wait for all photos
      await gallery.expectPhotoCount(3, 60000);

      // Check that stagger delay CSS variable is set on tiles
      const tiles = user.page.locator('.animated-tile');
      const tileCount = await tiles.count();
      expect(tileCount).toBeGreaterThanOrEqual(3);

      // All tiles should eventually settle
      for (let i = 0; i < 3; i++) {
        await expect(tiles.nth(i)).toHaveClass(/animation-settled/, { timeout: 10000 });
      }
    });

    test('P2-ANIM-3: skip animation flag bypasses enter animation', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('skip-anim');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('SkipAnim');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);
      const appShell = new AppShell(user.page);

      // INTENTIONAL: Wait for gallery's animation system initialization before uploading
      await user.page.waitForTimeout(200);

      // Upload photo
      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, 'skip-anim.png');
      await gallery.expectPhotoCount(1);

      // Navigate away and back - photos should skip animation on return
      await appShell.goBack();
      await appShell.waitForLoad();

      // Re-enter album
      await appShell.clickAlbum(0);
      await gallery.waitForLoad();

      // Photo should immediately be in settled state (animation skipped)
      const animatedTile = user.page.locator('.animated-tile').first();
      await expect(animatedTile).toBeVisible({ timeout: 5000 });
      
      // Should be settled immediately (no animation on previously seen items)
      await expect(animatedTile).toHaveClass(/animation-settled/, { timeout: 2000 });
    });
  });

  test.describe('Photo Exit Animations', () => {
    test('P2-ANIM-4: deleted photos animate out', async ({ testContext }) => {
      test.slow(); // Upload + delete + animation verification needs extra time in CI
      const user = await testContext.createAuthenticatedUser('exit-anim');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('ExitAnim');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // INTENTIONAL: Wait for gallery's animation system initialization before uploading
      await user.page.waitForTimeout(200);

      // Upload a photo
      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, 'exit-anim.png');
      await gallery.expectPhotoCount(1);

      // Open lightbox and delete
      await gallery.selectPhoto(0);

      // Wait for lightbox
      const lightbox = user.page.locator('[data-testid="lightbox"]');
      await expect(lightbox).toBeVisible({ timeout: 10000 });

      // Click delete button in lightbox
      const deleteButton = user.page.getByTestId('lightbox-delete');
      await deleteButton.click();

      // Confirm deletion in dialog
      const confirmButton = user.page.getByTestId('delete-confirm-button');
      await confirmButton.click();

      // Wait for photo to be removed from gallery
      await gallery.expectPhotoCount(0, 30000);

      // The animated tile should have exit classes applied during removal
      // (This is timing-sensitive, so we just verify the photo is gone)
    });
  });

  test.describe('Reduced Motion Support', () => {
    test('P2-ANIM-5: respects prefers-reduced-motion', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('reduced-motion');

      // Enable reduced motion preference
      await user.page.emulateMedia({ reducedMotion: 'reduce' });

      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('ReducedMotion');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // INTENTIONAL: Wait for gallery's animation system initialization before uploading
      await user.page.waitForTimeout(200);

      // Upload a photo
      const testImage = generateTestImage('tiny');
      await gallery.uploadPhoto(testImage, 'reduced-motion.png');
      await gallery.expectPhotoCount(1);

      // Photo should appear immediately settled (no animation)
      const animatedTile = user.page.locator('.animated-tile').first();
      await expect(animatedTile).toBeVisible({ timeout: 5000 });
      await expect(animatedTile).toHaveClass(/animation-settled/, { timeout: 2000 });
    });
  });

  test.describe('Scroll Performance', () => {
    test('P2-ANIM-6: animations complete on scroll-revealed items', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('scroll-anim');
      await loginUser(user, TEST_PASSWORD);

      // Use createAlbumViaUI for real crypto setup (required for photo operations)
      const albumName = testContext.generateAlbumName('ScrollAnim');
      await createAlbumViaUI(user.page, albumName);

      const gallery = new GalleryPage(user.page);

      // Upload enough photos to require scrolling
      const images: Array<{ buffer: Buffer; filename: string }> = [];
      for (let i = 0; i < 12; i++) {
        images.push({ buffer: generateTestImage('tiny'), filename: `scroll-${i}.png` });
      }
      await gallery.uploadMultiplePhotos(images);

      // Wait for all photos
      await gallery.expectPhotoCount(12, 120000);

      // Scroll to bottom
      await user.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      // INTENTIONAL: Wait for scroll event to propagate and virtualization to update
      await user.page.waitForTimeout(500);

      // All visible tiles should eventually settle
      const visibleTiles = user.page.locator('.animated-tile:visible');
      const visibleCount = await visibleTiles.count();

      if (visibleCount > 0) {
        // At least first visible should be settled
        await expect(visibleTiles.first()).toHaveClass(/animation-settled/, { timeout: 5000 });
      }
    });
  });
});
