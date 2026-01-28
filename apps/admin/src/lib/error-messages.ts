/**
 * Error message utilities for safe user-facing error display.
 * Maps internal error messages to user-friendly messages without leaking internals.
 */

import { CryptoError, CryptoErrorCode } from '@mosaic/crypto';
import { UploadError, UploadErrorCode } from './upload-errors';
import { ApiError } from './api';
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
 * Crypto error code to user-friendly message mapping.
 */
const CRYPTO_ERROR_MESSAGES: Partial<Record<CryptoErrorCode, string>> = {
  [CryptoErrorCode.INVALID_KEY_LENGTH]: 'Security key error. Please try logging in again.',
  [CryptoErrorCode.SIGNATURE_INVALID]: 'Content verification failed. The data may be corrupted.',
  [CryptoErrorCode.DECRYPTION_FAILED]: 'Unable to decrypt content. Please try again.',
  [CryptoErrorCode.INVALID_ENVELOPE]: 'Invalid data format. The data may be corrupted.',
  [CryptoErrorCode.RESERVED_NOT_ZERO]: 'Invalid data format. The data may be corrupted.',
  [CryptoErrorCode.INTEGRITY_FAILED]: 'Data integrity check failed. The data may be corrupted.',
  [CryptoErrorCode.CONTEXT_MISMATCH]: 'Security context mismatch. Please try again.',
  [CryptoErrorCode.KEY_CONVERSION_FAILED]: 'Key conversion failed. Please try logging in again.',
  [CryptoErrorCode.INVALID_INPUT]: 'Invalid input data.',
  [CryptoErrorCode.NOT_INITIALIZED]: 'Encryption not ready. Please refresh the page.',
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

  if (error instanceof CryptoError) {
    return CRYPTO_ERROR_MESSAGES[error.code] ?? fallback;
  }

  if (error instanceof EpochKeyError) {
    return EPOCH_KEY_ERROR_MESSAGES[error.code] ?? fallback;
  }

  // Handle API errors based on HTTP status
  if (error instanceof ApiError) {
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
    // Include error code if available
    if ('code' in error && typeof error.code === 'string') {
      return `${error.name}[${error.code}]`;
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
  
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { type, code: error.code };
  }
  
  if (error instanceof ApiError) {
    return { type, code: String(error.status) };
  }
  
  return { type };
}
