/**
 * Error message utilities for safe user-facing error display.
 * Maps internal error messages to user-friendly messages without leaking internals.
 *
 * Slice 7 — replaces the `@mosaic/crypto` `CryptoError` / `CryptoErrorCode`
 * mapping with the Rust-mirrored `WorkerCryptoError` / `WorkerCryptoErrorCode`
 * contract from the crypto worker. Messages cover both the Rust-mirrored
 * codes (envelope/integrity/auth/key-validation failures and bundle
 * verification) and the worker-only handle-lifecycle codes (StaleHandle,
 * HandleNotFound, etc.).
 */

import { WorkerCryptoError, WorkerCryptoErrorCode } from '../workers/types';
import { UploadError, UploadErrorCode } from './upload-errors';
import { EpochKeyError, EpochKeyErrorCode } from './epoch-key-service';

/**
 * Upload error code to user-friendly message mapping.
 */
const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  [UploadErrorCode.EPOCH_KEY_FAILED]: 'Unable to prepare album for upload. Please try again.',
  [UploadErrorCode.QUEUE_NOT_INITIALIZED]: 'Upload system not ready. Please refresh the page.',
  [UploadErrorCode.UPLOAD_FAILED]: 'Upload failed. Please check your connection and try again.',
  [UploadErrorCode.MANIFEST_FAILED]: 'Failed to save photo. Please try again.',
};

/**
 * WorkerCryptoErrorCode → user-friendly message mapping.
 *
 * Covers the Rust-mirrored codes from `mosaic_client::ClientErrorCode`
 * (100-series envelope/header validation, 200-series crypto operation
 * failures, 400-series handle lookup, 500-series state corruption) plus
 * the worker-only 1000-series handle-lifecycle codes.
 *
 * Codes that should never surface in the UI (e.g. transient cancellation,
 * rng-failure surrogates) fall through to the generic fallback below.
 */
const CRYPTO_ERROR_MESSAGES: Partial<Record<WorkerCryptoErrorCode, string>> = {
  // Envelope / header validation (Rust 100-series).
  [WorkerCryptoErrorCode.InvalidHeaderLength]:
    'Invalid data format. The data may be corrupted.',
  [WorkerCryptoErrorCode.InvalidMagic]:
    'Invalid data format. The data may be corrupted.',
  [WorkerCryptoErrorCode.UnsupportedVersion]:
    'Unsupported data format. Please refresh the page.',
  [WorkerCryptoErrorCode.InvalidTier]:
    'Invalid data format. The data may be corrupted.',
  [WorkerCryptoErrorCode.NonZeroReservedByte]:
    'Invalid data format. The data may be corrupted.',
  [WorkerCryptoErrorCode.UnknownEnvelopeVersion]:
    'Unsupported data format. Please refresh the page.',

  // Crypto operation failures (Rust 200-series).
  [WorkerCryptoErrorCode.EmptyContext]:
    'Security context missing. Please try again.',
  [WorkerCryptoErrorCode.InvalidKeyLength]:
    'Security key error. Please try logging in again.',
  [WorkerCryptoErrorCode.InvalidInputLength]: 'Invalid input data.',
  [WorkerCryptoErrorCode.InvalidEnvelope]:
    'Invalid data format. The data may be corrupted.',
  [WorkerCryptoErrorCode.MissingCiphertext]:
    'Invalid data format. The data may be corrupted.',
  [WorkerCryptoErrorCode.AuthenticationFailed]:
    'Unable to decrypt content. The data may be corrupted or the key is wrong.',
  [WorkerCryptoErrorCode.RngFailure]:
    'Encryption error. Please try again.',
  [WorkerCryptoErrorCode.WrappedKeyTooShort]:
    'Security key error. Please try logging in again.',
  [WorkerCryptoErrorCode.KdfProfileTooWeak]:
    'Password security policy error. Please contact support.',
  [WorkerCryptoErrorCode.InvalidSaltLength]:
    'Security key error. Please try logging in again.',
  [WorkerCryptoErrorCode.KdfFailure]:
    'Password processing failed. Please try again.',
  [WorkerCryptoErrorCode.InvalidSignatureLength]:
    'Content verification failed. The data may be corrupted.',
  [WorkerCryptoErrorCode.InvalidPublicKey]:
    'Security key error. Please try logging in again.',
  [WorkerCryptoErrorCode.InvalidUsername]: 'Invalid username.',
  [WorkerCryptoErrorCode.KdfProfileTooCostly]:
    'Password security policy error. Please contact support.',
  [WorkerCryptoErrorCode.LinkTierMismatch]:
    'Share link tier mismatch. Please try a different link.',
  [WorkerCryptoErrorCode.BundleSignatureInvalid]:
    'Album key signature verification failed.',
  [WorkerCryptoErrorCode.BundleAlbumIdEmpty]:
    'Album key bundle is missing required identifiers.',
  [WorkerCryptoErrorCode.BundleAlbumIdMismatch]:
    'Album key bundle does not match this album.',
  [WorkerCryptoErrorCode.BundleEpochTooOld]:
    'Album key bundle is outdated. Please reload the page.',
  [WorkerCryptoErrorCode.BundleRecipientMismatch]:
    'Album key bundle was sealed for a different account.',
  [WorkerCryptoErrorCode.BundleJsonParse]:
    'Album key bundle is corrupted.',
  [WorkerCryptoErrorCode.BundleSealOpenFailed]:
    'Unable to unseal album keys. The bundle may be corrupted.',
  [WorkerCryptoErrorCode.ShardIntegrityFailed]:
    'Downloaded photo data failed integrity checks. Please try again.',
  [WorkerCryptoErrorCode.LegacyRawKeyDecryptFallback]:
    'Unable to unlock legacy encrypted data. Please log in again.',
  [WorkerCryptoErrorCode.StreamingChunkOutOfOrder]:
    'Downloaded photo data arrived out of order. Please try again.',
  [WorkerCryptoErrorCode.StreamingTotalChunkMismatch]:
    'Downloaded photo data is incomplete. Please try again.',
  [WorkerCryptoErrorCode.StreamingPlaintextDivergence]:
    'Downloaded photo data failed verification. Please try again.',

  // Cancellation (300-series).
  [WorkerCryptoErrorCode.OperationCancelled]: 'Operation was cancelled.',

  // Handle lookup failures (Rust 400-series).
  [WorkerCryptoErrorCode.SecretHandleNotFound]:
    'Encryption session expired. Please refresh the page.',
  [WorkerCryptoErrorCode.IdentityHandleNotFound]:
    'Identity not ready. Please log in again.',
  [WorkerCryptoErrorCode.HandleSpaceExhausted]:
    'Too many open encryption sessions. Please refresh the page.',
  [WorkerCryptoErrorCode.EpochHandleNotFound]:
    'Album encryption keys are not loaded. Please reload the album.',

  // State corruption (Rust 500-series).
  [WorkerCryptoErrorCode.InternalStatePoisoned]:
    'Encryption subsystem is in a bad state. Please refresh the page.',

  // Media and metadata validation (Rust 600-series).
  [WorkerCryptoErrorCode.UnsupportedMediaFormat]:
    'This media format is not supported.',
  [WorkerCryptoErrorCode.InvalidMediaContainer]:
    'This media file appears to be invalid or corrupted.',
  [WorkerCryptoErrorCode.InvalidMediaDimensions]:
    'This media file has invalid dimensions.',
  [WorkerCryptoErrorCode.MediaOutputTooLarge]:
    'Processed media is too large to upload.',
  [WorkerCryptoErrorCode.MediaMetadataMismatch]:
    'Media metadata does not match the file contents.',
  [WorkerCryptoErrorCode.InvalidMediaSidecar]:
    'Media metadata is invalid or corrupted.',
  [WorkerCryptoErrorCode.MediaAdapterOutputMismatch]:
    'Media processing produced inconsistent output. Please try again.',
  [WorkerCryptoErrorCode.VideoContainerInvalid]:
    'This video file appears to be invalid or corrupted.',
  [WorkerCryptoErrorCode.MediaInspectFailed]:
    'Unable to inspect this media file.',
  [WorkerCryptoErrorCode.MediaStripFailed]:
    'Unable to remove unsafe metadata from this media file.',
  [WorkerCryptoErrorCode.SidecarFieldOverflow]:
    'Media metadata is too large to process.',
  [WorkerCryptoErrorCode.SidecarTagUnknown]:
    'Media metadata contains an unsupported field.',
  [WorkerCryptoErrorCode.MalformedSidecar]:
    'Media metadata is malformed.',
  [WorkerCryptoErrorCode.MakerNoteRejected]:
    'Unsupported camera metadata was rejected.',
  [WorkerCryptoErrorCode.ExifTraversalLimitExceeded]:
    'Media metadata is too deeply nested to process safely.',
  [WorkerCryptoErrorCode.VideoTooLargeForV1]:
    'This video is too large for the current upload format.',
  [WorkerCryptoErrorCode.VideoSourceUnreadable]:
    'Unable to read this video file.',
  [WorkerCryptoErrorCode.VideoTierShapeRejected]:
    'Generated video tiers are invalid. Please try again.',
  [WorkerCryptoErrorCode.MetadataSidecarReservedTagNotPromoted]:
    'Media metadata contains a reserved field that cannot be uploaded.',

  // Client workflow / sync state (Rust 700-series).
  [WorkerCryptoErrorCode.ClientCoreInvalidTransition]:
    'Sync reached an invalid state. Please refresh the page.',
  [WorkerCryptoErrorCode.ClientCoreMissingEventPayload]:
    'Sync data is incomplete. Please refresh the page.',
  [WorkerCryptoErrorCode.ClientCoreRetryBudgetExhausted]:
    'Sync retry limit reached. Please check your connection and try again.',
  [WorkerCryptoErrorCode.ClientCoreSyncPageDidNotAdvance]:
    'Sync could not make progress. Please refresh the page.',
  [WorkerCryptoErrorCode.ClientCoreManifestOutcomeUnknown]:
    'Photo sync returned an unknown result. Please try again.',
  [WorkerCryptoErrorCode.ClientCoreUnsupportedSnapshotVersion]:
    'Local sync data is from an unsupported version. Please refresh the page.',
  [WorkerCryptoErrorCode.ClientCoreInvalidSnapshot]:
    'Local sync data is corrupted. Please refresh the page.',
  [WorkerCryptoErrorCode.ManifestShapeRejected]:
    'Photo manifest data is invalid.',
  [WorkerCryptoErrorCode.IdempotencyExpired]:
    'This upload session expired. Please try again.',
  [WorkerCryptoErrorCode.ManifestSetConflict]:
    'The album changed during sync. Please reload and try again.',
  [WorkerCryptoErrorCode.BackendIdempotencyConflict]:
    'This request conflicts with a previous request. Please reload and try again.',
  [WorkerCryptoErrorCode.VideoPosterExtractionFailed]:
    'Unable to create a preview image for this video.',
  [WorkerCryptoErrorCode.DownloadInvalidPlan]:
    'Download plan is invalid. Please try again.',
  [WorkerCryptoErrorCode.DownloadIllegalTransition]:
    'Download reached an invalid state. Please restart the download.',
  [WorkerCryptoErrorCode.DownloadSnapshotMigration]:
    'Saved download state is from an unsupported version. Please restart the download.',
  [WorkerCryptoErrorCode.DownloadSnapshotCorrupt]:
    'Saved download state is corrupted. Please restart the download.',
  [WorkerCryptoErrorCode.DownloadSnapshotChecksumMismatch]:
    'Saved download state failed integrity checks. Please restart the download.',
  [WorkerCryptoErrorCode.DownloadSnapshotTorn]:
    'Saved download state is incomplete. Please restart the download.',
  [WorkerCryptoErrorCode.DownloadTransientNetwork]:
    'Network interrupted the download. Please try again.',
  [WorkerCryptoErrorCode.DownloadIntegrity]:
    'Downloaded data failed integrity checks. Please try again.',
  [WorkerCryptoErrorCode.DownloadDecrypt]:
    'Unable to decrypt downloaded data. Please log in again.',
  [WorkerCryptoErrorCode.DownloadNotFound]:
    'A downloaded item was not found. Please refresh and try again.',
  [WorkerCryptoErrorCode.DownloadQuota]:
    'Not enough storage is available for this download.',
  [WorkerCryptoErrorCode.DownloadCancelled]: 'Download was cancelled.',
  [WorkerCryptoErrorCode.DownloadAccessRevoked]:
    'Access to this download was revoked.',
  [WorkerCryptoErrorCode.DownloadAuthorizationChanged]:
    'Your permissions changed. Please refresh and try again.',
  [WorkerCryptoErrorCode.DownloadIllegalState]:
    'Download is in an invalid state. Please restart it.',
  [WorkerCryptoErrorCode.PinValidationFailed]:
    'The pairing PIN could not be verified. Please try again.',

  // Worker-only handle-lifecycle codes (1000-series).
  [WorkerCryptoErrorCode.StaleHandle]:
    'Encryption session expired. Please refresh the page.',
  [WorkerCryptoErrorCode.HandleNotFound]:
    'Encryption session expired. Please refresh the page.',
  [WorkerCryptoErrorCode.HandleWrongKind]:
    'Encryption subsystem is in a bad state. Please refresh the page.',
  [WorkerCryptoErrorCode.ClosedHandle]:
    'Encryption session was closed. Please refresh the page.',
  [WorkerCryptoErrorCode.WorkerNotInitialized]:
    'Encryption not ready. Please refresh the page.',
};

/**
 * Epoch key error code to user-friendly message mapping.
 */
const EPOCH_KEY_ERROR_MESSAGES: Record<EpochKeyErrorCode, string> = {
  [EpochKeyErrorCode.FETCH_FAILED]: 'Unable to load album keys. Please try again.',
  [EpochKeyErrorCode.NO_KEYS_AVAILABLE]: 'No encryption keys available for this album.',
  [EpochKeyErrorCode.IDENTITY_NOT_DERIVED]: 'Security keys not ready. Please log in again.',
  [EpochKeyErrorCode.SIGNATURE_INVALID]: 'Key signature verification failed.',
  [EpochKeyErrorCode.DECRYPTION_FAILED]: 'Unable to unlock album keys.',
  [EpochKeyErrorCode.CONTEXT_MISMATCH]: 'Album key context mismatch.',
};

/**
 * HTTP status code to user-friendly message mapping.
 */
const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: 'Invalid request. Please check your input.',
  401: 'Please log in to continue.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested item was not found.',
  409: 'This item already exists or conflicts with another.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Server error. Please try again later.',
  502: 'Server unavailable. Please try again later.',
  503: 'Service temporarily unavailable. Please try again later.',
  504: 'Request timed out. Please try again.',
};

function isApiErrorLike(error: unknown): error is {
  readonly status: number;
  readonly problem?: { readonly detail?: unknown };
} {
  return (
    error instanceof Error &&
    error.name === 'ApiError' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

/**
 * Converts an error to a safe, user-friendly message.
 *
 * This function:
 * 1. Maps known error codes to predefined messages
 * 2. Handles API errors based on HTTP status
 * 3. Returns a generic message for unknown errors
 *
 * @param error - The error to convert
 * @param fallback - Optional fallback message for unknown errors
 * @returns A user-friendly error message
 */
export function toSafeErrorMessage(
  error: unknown,
  fallback = 'An unexpected error occurred. Please try again.',
): string {
  // Handle null/undefined
  if (error == null) {
    return fallback;
  }

  // Handle known error types with error codes
  if (error instanceof UploadError) {
    return UPLOAD_ERROR_MESSAGES[error.code] ?? fallback;
  }

  // WorkerCryptoError carries a numeric stable code; detect via the
  // structural `is(...)` helper so Comlink-cloned cross-realm errors
  // also resolve to the right mapping.
  if (WorkerCryptoError.is(error)) {
    return CRYPTO_ERROR_MESSAGES[error.code] ?? fallback;
  }

  if (error instanceof EpochKeyError) {
    return EPOCH_KEY_ERROR_MESSAGES[error.code] ?? fallback;
  }

  // Handle API errors based on HTTP status
  if (isApiErrorLike(error)) {
    if (
      typeof error.problem?.detail === 'string' &&
      error.problem.detail.trim().length > 0
    ) {
      return error.problem.detail;
    }

    return HTTP_STATUS_MESSAGES[error.status] ?? fallback;
  }

  // Handle network errors
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'Network error. Please check your connection.';
  }

  // Handle AbortError (request cancelled)
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Request was cancelled.';
  }

  // For plain Error instances, return fallback (don't expose error.message)
  // This prevents internal details from leaking to the UI
  return fallback;
}

/**
 * Gets the error type name for logging purposes.
 * Safe to log as it only contains error type, not sensitive details.
 *
 * @param error - The error to get the type for
 * @returns The error type name
 */
export function getErrorType(error: unknown): string {
  if (error == null) {
    return 'null';
  }

  if (error instanceof Error) {
    // Include error code if available (string or number — WorkerCryptoError
    // uses numeric codes, others may use string codes).
    if ('code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' || typeof code === 'number') {
        return `${error.name}[${code}]`;
      }
    }
    return error.name;
  }

  return typeof error;
}

/**
 * Creates a structured error info object safe for logging.
 * Does not include the full error message which may contain sensitive data.
 *
 * @param error - The error to create info for
 * @returns An object with error type and code (if available)
 */
export function getSafeErrorInfo(error: unknown): { type: string; code?: string } {
  const type = getErrorType(error);

  if (error instanceof Error && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') {
      return { type, code: String(code) };
    }
  }

  if (isApiErrorLike(error)) {
    return { type, code: String(error.status) };
  }

  return { type };
}
