/**
 * E2E Test Framework
 *
 * Barrel export for all framework utilities.
 */

export {
  API_URL,
  BASE_URL,
  TEST_PASSWORD,
  TEST_CONSTANTS,
} from './constants';

export {
  TestContext,
  generateTestId,
  generateUserEmail,
  createCollaborationContext,
  type AuthenticatedUser,
  type CollaborationContext,
} from './test-context';

export {
  generateTestImage,
  createAlbumViaAPI,
  deleteAlbumViaAPI,
  getAlbumsViaAPI,
  getCurrentUserViaAPI,
  checkBackendHealth,
  waitForBackendHealth,
  prepareFileUpload,
  ensureUserExists,
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
  raceWithTimeout,
  waitForLoginOutcome,
  type WaitOptions,
  type LoginOutcome,
} from './wait-utils';

export {
  getPoolUserByIndex,
  isPoolUser,
  createCustomUser,
  generateDynamicUserEmail,
  POOL_USERS,
  type AuthMode,
  type PoolUser,
} from './test-user-pool';

export {
  LogCollector,
  TestAPIClient,
  type CreateAuthenticatedUserResponse,
} from './test-api-client';
