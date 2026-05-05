import type { EpochHandleId, TieredShardIds } from '../../workers/types';
import { SNAPSHOT_VERSION } from './legacy-drainer';

/** Chunk size for splitting files (6MB) */
export const CHUNK_SIZE = 6 * 1024 * 1024;

/** Maximum number of retry attempts before marking as permanently failed */
export const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (1 second) */
export const BASE_DELAY_MS = 1000;

/** Threshold for stale failed tasks (1 hour in milliseconds) */
export const STALE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Calculate retry delay using exponential backoff
 * @param retryCount - Number of retries attempted (0-indexed)
 * @returns Delay in milliseconds (1s, 2s, 4s, 8s, ...)
 */
export function getRetryDelay(retryCount: number): number {
  return BASE_DELAY_MS * Math.pow(2, retryCount);
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Upload task status */
export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'complete'
  | 'error'
  | 'permanently_failed';
export type UploadAction =
  | 'pending'
  | 'converting'
  | 'encrypting'
  | 'uploading'
  | 'finalizing';

/** Completed shard with ID and hash for integrity verification */
export interface CompletedShard {
  index: number;
  shardId: string;
  sha256: string; // Base64url hash for verification
  /** Shard tier: 1=thumb, 2=preview, 3=original */
  tier?: number;
}

/** Tiered shard result from upload (3 tiers) */
export interface TieredUploadResult {
  thumbnail: CompletedShard;
  preview: CompletedShard;
  original: CompletedShard[];
}

/** Video-specific metadata extracted during upload (from HTMLVideoElement) */
export interface VideoUploadMetadata {
  /** Always true for video files */
  isVideo: true;
  /** Duration in seconds (e.g., 62.5) */
  duration: number;
  /** Native video width in pixels */
  width: number;
  /** Native video height in pixels */
  height: number;
  /** Video codec (e.g., "h264", "vp9") — best-effort detection */
  videoCodec?: string;
  /** Base64-encoded embedded thumbnail extracted from video frame */
  thumbnail?: string;
  /** Embedded thumbnail width */
  thumbWidth?: number;
  /** Embedded thumbnail height */
  thumbHeight?: number;
  /** ThumbHash for instant placeholder */
  thumbhash?: string;
}

/** In-memory upload task */
export interface UploadTask {
  id: string;
  file: File;
  albumId: string;
  epochId: number;
  epochHandleId: EpochHandleId;
  status: UploadStatus;
  currentAction: UploadAction;
  progress: number;
  completedShards: CompletedShard[];
  error?: string;
  /** Number of retry attempts made */
  retryCount: number;
  /** Timestamp of the last attempt (for backoff calculation) */
  lastAttemptAt: number;
  /** Generated thumbnail base64 (set during upload) */
  thumbnailBase64?: string;
  /** Thumbnail width */
  thumbWidth?: number;
  /** Thumbnail height */
  thumbHeight?: number;
  /** Original image width */
  originalWidth?: number;
  /** Original image height */
  originalHeight?: number;
  /** ThumbHash string for instant placeholder (~25 bytes base64) */
  thumbhash?: string;
  /** Tiered shard IDs for the completed upload */
  tieredShards?: TieredShardIds;
  /** Detected MIME type from magic bytes (more reliable than file.type) */
  detectedMimeType?: string;
  /** Video metadata (set during upload for video files) */
  videoMetadata?: VideoUploadMetadata;
}

/** Persisted task state (for resume after reload) */
export interface PersistedTask {
  id: string;
  schemaVersion?: typeof SNAPSHOT_VERSION;
  snapshotVersion?: typeof SNAPSHOT_VERSION;
  idempotencyKey?: string;
  albumId: string;
  fileName: string;
  fileSize: number;
  epochId: number;
  totalChunks: number;
  completedShards: CompletedShard[];
  status: string;
  /** Number of retry attempts made */
  retryCount: number;
  /** Timestamp of the last attempt */
  lastAttemptAt: number;
  /** Base64-encoded thumbnail (generated once, persisted for resume) */
  thumbnailBase64?: string;
  /** Thumbnail width */
  thumbWidth?: number;
  /** Thumbnail height */
  thumbHeight?: number;
  /** Original image width */
  originalWidth?: number;
  /** Original image height */
  originalHeight?: number;
  /** ThumbHash string for instant placeholder (~25 bytes base64) */
  thumbhash?: string;
  /** Tiered shard IDs persisted after tiered/video upload completion */
  tieredShards?: TieredShardIds;
  /** Video metadata (persisted for resume) */
  videoMetadata?: VideoUploadMetadata;
}

/** IndexedDB schema */
export interface UploadQueueDB {
  tasks: {
    key: string;
    value: PersistedTask;
  };
}

export type ProgressCallback = (task: UploadTask) => void;
export type CompleteCallback = (
  task: UploadTask,
  shardIds: string[],
  tieredShards?: TieredShardIds,
) => void | Promise<void>;
export type ErrorCallback = (task: UploadTask, error: Error) => void;

/** Context passed to upload handlers for callbacks and shared operations */
export interface UploadHandlerContext {
  tusUpload: (
    albumId: string,
    data: Uint8Array,
    sha256: string,
    shardIndex: number,
  ) => Promise<string>;
  updatePersistedTask: (
    id: string,
    updates: Partial<PersistedTask>,
  ) => Promise<void>;
  onProgress: ProgressCallback | undefined;
  onComplete: CompleteCallback | undefined;
}
