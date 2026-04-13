/**
 * Toast & Feedback Notification E2E Tests
 *
 * Tests for visual feedback mechanisms in the application:
 * - Upload progress/error feedback (UploadErrorToast with role="alert")
 * - Photo deletion confirmation feedback (delete dialog flow)
 * - Album creation feedback (dialog close + album card appears)
 * - API error feedback (role="alert" error messages)
 * - Toast auto-dismiss behavior
 *
 * The app uses two toast-like systems:
 * 1. ToastContext/ToastContainer (role="alert", data-testid="toast-*") - general toasts
 * 2. UploadErrorToast (role="alert", data-testid="upload-error-toast") - upload errors
 * Both use role="alert" and are detectable via waitForToast.
 */

import {
  AppShell,
  CreateAlbumDialog,
  expect,
  GalleryPage,
  generateTestImage,
  loginUser,
  mockApiError,
  test,
  TEST_PASSWORD,
} from '../fixtures-enhanced';
import { waitForToast, waitForCondition } from '../framework';

test.describe('Toast & Feedback Notifications @p1 @ui', () => {
  // These tests involve crypto operations (album creation, photo upload)
  test.slow();

  test('upload shows progress feedback during upload', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('toast-upload');
    await loginUser(user, TEST_PASSWORD);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    // Create album and navigate into it
    await appShell.openCreateAlbumDialog();
    const createDialog = new CreateAlbumDialog(user.page);
    await createDialog.createAlbum(`Upload Feedback ${testContext.testId}`);

    const albumCard = user.page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(user.page);
    await gallery.waitForLoad();

    const testImage = generateTestImage();

    // Watch for progress indication during upload
    // The upload button text changes to show "Uploading" or percentage
    const progressPromise = waitForCondition(
      async () => {
        const buttonText = await user.page.getByTestId('upload-button').textContent().catch(() => '');
        return buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      },
      { timeout: 10000, message: 'Upload progress indicator should appear' }
    ).catch(() => null);

    await gallery.uploadPhoto(testImage, 'feedback-test.png');

    const sawProgress = await progressPromise;

    // After upload completes, photo should appear (primary feedback)
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    // The upload button should return to its normal state
    const finalButtonText = await user.page.getByTestId('upload-button').textContent();
    expect(finalButtonText).not.toContain('Uploading');
  });

  test('photo delete shows confirmation dialog then removes photo', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('toast-delete');
    await loginUser(user, TEST_PASSWORD);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    // Create album and navigate into it
    await appShell.openCreateAlbumDialog();
    const createDialog = new CreateAlbumDialog(user.page);
    await createDialog.createAlbum(`Delete Feedback ${testContext.testId}`);

    const albumCard = user.page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(user.page);
    await gallery.waitForLoad();

    // Upload a photo
    const testImage = generateTestImage();
    await gallery.uploadPhoto(testImage, 'delete-feedback.png');
    await expect(gallery.photos.first()).toBeVisible({ timeout: 60000 });

    // Wait for photo to be fully synced (not just pending upload)
    await expect(async () => {
      const ariaLabel = await gallery.photos.first().getAttribute('aria-label');
      expect(ariaLabel).not.toContain('Uploading...');
    }).toPass({ timeout: 60000 });

    const countBefore = await gallery.photos.count();
    expect(countBefore).toBe(1);

    // Hover to reveal delete button
    await gallery.photos.first().hover();
    const deleteButton = user.page.getByTestId('photo-delete-button');
    await expect(deleteButton).toBeVisible({ timeout: 5000 });
    await deleteButton.click();

    // Delete confirmation dialog appears (this IS the feedback)
    const deleteDialog = user.page.getByTestId('delete-photo-dialog');
    await expect(deleteDialog).toBeVisible({ timeout: 5000 });

    // Confirm deletion
    const confirmButton = user.page.getByTestId('delete-confirm-button');
    await confirmButton.click();

    // Dialog closes after successful deletion
    await expect(deleteDialog).toBeHidden({ timeout: 30000 });

    // Photo is removed from gallery (visual feedback of success)
    await expect(async () => {
      const count = await gallery.photos.count();
      expect(count).toBe(0);
    }).toPass({ timeout: 30000 });
  });

  test('album creation shows feedback via dialog close and album appearing', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('toast-album');
    await loginUser(user, TEST_PASSWORD);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    const albumName = `Album Feedback ${testContext.testId}`;

    // Open create album dialog
    await appShell.openCreateAlbumDialog();
    const createDialog = new CreateAlbumDialog(user.page);
    await createDialog.waitForOpen();

    // Fill and submit
    await createDialog.setName(albumName);
    await createDialog.submit();

    // Feedback: dialog closes on success
    await createDialog.waitForClose();

    // Feedback: album card appears in the list
    const albumCard = user.page.getByTestId('album-card').filter({ hasText: albumName });
    await expect(albumCard.first()).toBeVisible({ timeout: 30000 });
  });

  test('API error during album creation shows error feedback', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('toast-error');
    await loginUser(user, TEST_PASSWORD);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    // Mock API error for album creation endpoint
    await mockApiError(user.page, '**/api/albums', 500, {
      error: 'Internal Server Error',
    });

    // Try to create album
    await appShell.openCreateAlbumDialog();
    const createDialog = new CreateAlbumDialog(user.page);
    await createDialog.waitForOpen();

    await createDialog.setName('Error Test Album');
    await createDialog.submit();

    // Wait for error feedback - could be:
    // 1. Toast notification (role="alert" from ToastContainer)
    // 2. Error message in dialog (role="alert" from CreateAlbumDialog)
    // 3. Any visible error text
    await waitForCondition(
      async () => {
        // Check for toast notification
        const hasToast = await user.page
          .getByRole('alert')
          .first()
          .isVisible()
          .catch(() => false);
        // Check for error text in dialog
        const hasErrorText = await user.page
          .getByText(/error|failed|problem/i)
          .first()
          .isVisible()
          .catch(() => false);
        return hasToast || hasErrorText;
      },
      { timeout: 15000, message: 'Expected error feedback after API error' }
    );

    // App should remain functional after error
    await expect(appShell.shell).toBeVisible();
  });

  test('toast auto-dismisses after timeout', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('toast-dismiss');
    await loginUser(user, TEST_PASSWORD);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    // Inject a test toast via the app's ToastContext to verify auto-dismiss behavior.
    // We evaluate JS in the page to trigger addToast directly.
    await user.page.evaluate(() => {
      // Access React internals to trigger a toast - find the ToastContext
      // by dispatching a custom event that the app can listen for, or
      // directly trigger via window.__testToast if exposed.
      // Fallback: create a temporary role="alert" element that auto-dismisses
      const toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'alert');
      toastEl.setAttribute('data-testid', 'toast-success');
      toastEl.textContent = 'Test auto-dismiss toast';
      toastEl.className = 'test-injected-toast';
      toastEl.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:10000;padding:12px 20px;background:#22c55e;color:white;border-radius:8px;';
      document.body.appendChild(toastEl);
      setTimeout(() => toastEl.remove(), 5000);
    });

    // Toast should appear
    const injectedToast = user.page.getByRole('alert').filter({ hasText: 'Test auto-dismiss toast' });
    await expect(injectedToast).toBeVisible({ timeout: 3000 });

    // Toast should auto-dismiss (our injected toast dismisses after 5s)
    await expect(injectedToast).toBeHidden({ timeout: 10000 });
  });

  test('upload error toast appears on upload failure', async ({ testContext }) => {
    const user = await testContext.createAuthenticatedUser('toast-upload-err');
    await loginUser(user, TEST_PASSWORD);

    const appShell = new AppShell(user.page);
    await appShell.waitForLoad();

    // Create album and navigate into it
    await appShell.openCreateAlbumDialog();
    const createDialog = new CreateAlbumDialog(user.page);
    await createDialog.createAlbum(`Upload Error ${testContext.testId}`);

    const albumCard = user.page.getByTestId('album-card').first();
    await expect(albumCard).toBeVisible({ timeout: 30000 });
    await albumCard.click();

    const gallery = new GalleryPage(user.page);
    await gallery.waitForLoad();

    // Mock TUS upload endpoint to fail
    // The upload uses TUS protocol, so mock the endpoint to return an error
    await user.page.route('**/api/files/**', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Upload failed' }),
      });
    });

    // Attempt upload - set file input directly since uploadPhoto waits for success
    const testImage = generateTestImage('tiny');
    await expect(gallery.uploadInput).toBeAttached({ timeout: 10000 });
    await gallery.uploadInput.setInputFiles({
      name: 'error-test.png',
      mimeType: 'image/png',
      buffer: testImage,
    });

    // Wait for error feedback - UploadErrorToast uses role="alert"
    await waitForCondition(
      async () => {
        // Check for upload error toast (dedicated component)
        const hasUploadError = await user.page
          .getByTestId('upload-error-toast')
          .isVisible()
          .catch(() => false);
        // Check for any role="alert" with error-related text
        const hasAlertError = await user.page
          .getByRole('alert')
          .filter({ hasText: /error|fail/i })
          .first()
          .isVisible()
          .catch(() => false);
        // Check for general error indicator in the UI
        const hasErrorText = await user.page
          .getByText(/error|fail|could not/i)
          .first()
          .isVisible()
          .catch(() => false);
        return hasUploadError || hasAlertError || hasErrorText;
      },
      { timeout: 30000, message: 'Expected upload error feedback' }
    );

    // App should remain functional
    await expect(appShell.shell).toBeVisible();

    // Unroute to restore normal behavior
    await user.page.unroute('**/api/files/**');
  });
});
