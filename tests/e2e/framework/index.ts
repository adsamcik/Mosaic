/**
 * E2E Test Framework
 *
 * Barrel export for all framework utilities.
 */

export {
  TestContext,
  generateTestId,
  generateUserEmail,
  createCollaborationContext,
  type AuthenticatedUser,
  type CollaborationContext,
} from './test-context';

export {
  TEST_PASSWORD,
  generateTestImage,
  createAlbumViaAPI,
  deleteAlbumViaAPI,
  getAlbumsViaAPI,
  getCurrentUserViaAPI,
  checkBackendHealth,
  waitForBackendHealth,
  prepareFileUpload,
  type ImageSize,
  type AlbumCreationResult,
} from './test-data-factory';

export {
  waitForCondition,
  waitForStable,
  waitForNetworkIdle,
  waitForCryptoReady,
  waitForPageReady,
  waitForToast,
  waitForUploadComplete,
  waitForDialog,
  waitForDialogClosed,
  retry,
  type WaitOptions,
} from './wait-utils';
