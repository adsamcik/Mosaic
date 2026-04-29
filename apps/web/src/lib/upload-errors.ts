/**
 * Centralized upload error types and shared logging helpers.
 * Used by UploadContext, useUpload hook, and the upload pipeline.
 */

import type { UploadTask } from './upload/types';

/** Error thrown when upload fails */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: UploadErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Upload error codes */
export enum UploadErrorCode {
  /** Failed to get epoch key for album */
  EPOCH_KEY_FAILED = 'EPOCH_KEY_FAILED',
  /** Upload queue not initialized */
  QUEUE_NOT_INITIALIZED = 'QUEUE_NOT_INITIALIZED',
  /** Generic upload error */
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  /** Failed to create manifest after upload */
  MANIFEST_FAILED = 'MANIFEST_FAILED',
}

/**
 * Redacted identity object for upload-related log lines.
 *
 * Excludes `file.name` to avoid leaking PII (passport scans, paycheck images,
 * project names, etc.) into log aggregation services such as Sentry/Datadog
 * if the log level is ever elevated for diagnostics. Includes the task id so
 * log lines can still be correlated by operators with access to the user's
 * own client-side state. The user already knows their own filename — we just
 * don't want it leaving the client in an unencrypted channel.
 *
 * The index signature lets the helper output be passed directly as a
 * `Record<string, unknown>` log context, or spread into a wider context.
 */
export interface UploadLogIdentity {
  /** UUID assigned by the upload queue. Safe to log. */
  taskId: string;
  /** MIME type from the File object, or undefined if the browser supplied none. */
  mimeType: string | undefined;
  /** File size in bytes. Useful for diagnostics; not sensitive. */
  sizeBytes: number;
  /** Allow the result to satisfy logger context shapes. */
  [key: string]: unknown;
}

/** Build the redacted identity for an UploadTask. */
export function taskIdentity(task: UploadTask): UploadLogIdentity {
  return {
    taskId: task.id,
    mimeType: task.file.type || undefined,
    sizeBytes: task.file.size,
  };
}

/**
 * Redacted identity for a raw File without an associated task id (e.g. when
 * a file has just been handed to UploadQueue.add and no taskId has been
 * generated yet).
 */
export interface FileLogIdentity {
  mimeType: string | undefined;
  sizeBytes: number;
  [key: string]: unknown;
}

/** Build the redacted identity for a File. */
export function fileIdentity(file: File): FileLogIdentity {
  return {
    mimeType: file.type || undefined,
    sizeBytes: file.size,
  };
}
