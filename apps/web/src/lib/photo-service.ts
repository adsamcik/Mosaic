/**
 * Photo Assembly Service
 *
 * Downloads encrypted shards, decrypts them using the crypto worker,
 * and assembles them into displayable photo blobs.
 *
 * Features:
 * - In-memory cache for decrypted thumbnails
 * - Blob URL lifecycle management
 * - Parallel shard downloads
 * - Embedded thumbnail support for fast gallery loading
 * - HEIC/HEIF decoding for browser display
 */

import { getCryptoClient } from './crypto-client';
import { createDisplayableUrl } from './image-decoder';
import { downloadShards, type ProgressCallback } from './shard-service';
import { base64ToUint8Array } from './thumbnail-generator';
import { createLogger } from './logger';
import type { EpochHandleId } from '../workers/types';

const log = createLogger('PhotoService');

/**
 * Cached photo entry with blob URL and reference count
 */
interface CacheEntry {
  blobUrl: string;
  blob: Blob;
  refCount: number;
  lastAccess: number;
}

/**
 * Photo loading options
 */
export interface PhotoLoadOptions {
  /** Progress callback for download progress */
  onProgress?: ProgressCallback;
  /** Whether to skip cache (force reload) */
  skipCache?: boolean;
}

/**
 * Photo load result
 */
export interface PhotoLoadResult {
  blobUrl: string;
  mimeType: string;
  size: number;
}

/**
 * Error thrown when photo assembly fails
 */
export class PhotoAssemblyError extends Error {
  constructor(
    public readonly photoId: string,
    public readonly cause: Error,
  ) {
    super(`Failed to assemble photo ${photoId}: ${cause.message}`);
    this.name = 'PhotoAssemblyError';
  }
}

// =============================================================================
// In-Memory Cache
// =============================================================================

/** Cache of decrypted photo blobs keyed by photo ID */
const photoCache = new Map<string, CacheEntry>();

/** Maximum cache size in bytes (default: 100MB) */
const MAX_CACHE_SIZE = 100 * 1024 * 1024;

/** Maximum cache entries */
const MAX_CACHE_ENTRIES = 200;

/** Current cache size in bytes */
let currentCacheSize = 0;

// =============================================================================
// Memory Pressure Handling
// =============================================================================

/** Ratio to reduce cache to when under memory pressure (25% of max) */
const REDUCED_CACHE_RATIO = 0.25;

/** Track if tab is currently backgrounded */
let isTabBackgrounded = false;

/** Track if memory pressure handling is initialized */
let memoryPressureInitialized = false;

/**
 * Check if the tab is currently backgrounded
 */
export function isMemoryPressureActive(): boolean {
  return isTabBackgrounded;
}

/**
 * Reduce cache sizes to a fraction of their normal maximum.
 * Used when tab is backgrounded to free memory.
 *
 * @param ratio - Target ratio (0.0 to 1.0) of max cache size
 */
export function reduceCacheToRatio(ratio: number): void {
  const targetPhotoSize = Math.floor(MAX_CACHE_SIZE * ratio);

  log.info(
    `Reducing photo cache to ${Math.round(ratio * 100)}% (target: ${targetPhotoSize} bytes)`,
  );

  // Evict photo cache entries
  const photoEntries = Array.from(photoCache.entries()).sort(
    ([, a], [, b]) => a.lastAccess - b.lastAccess,
  );

  for (const [id, entry] of photoEntries) {
    if (currentCacheSize <= targetPhotoSize) break;
    if (entry.refCount > 0) continue; // Don't evict in-use photos

    URL.revokeObjectURL(entry.blobUrl);
    currentCacheSize -= entry.blob.size;
    photoCache.delete(id);
  }

  log.info(
    `Photo cache reduced: entries=${photoCache.size}, size=${currentCacheSize} bytes`,
  );
}

/**
 * Handle visibility change events to manage memory
 */
function handleVisibilityChange(): void {
  if (document.hidden) {
    // Tab is now hidden - reduce cache to save memory
    isTabBackgrounded = true;
    reduceCacheToRatio(REDUCED_CACHE_RATIO);
    // Also reduce thumbnail cache
    reduceThumbnailCacheToRatio(REDUCED_CACHE_RATIO);
  } else {
    // Tab is now visible - resume normal caching
    isTabBackgrounded = false;
    log.info('Tab visible - resuming normal cache behavior');
  }
}

/**
 * Initialize memory pressure handling.
 * Call this during app initialization.
 */
export function initMemoryPressureHandling(): void {
  if (memoryPressureInitialized) return;

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    memoryPressureInitialized = true;
    log.info('Memory pressure handling initialized');
  }
}

/**
 * Cleanup memory pressure handling.
 * Call this during app teardown.
 */
export function cleanupMemoryPressureHandling(): void {
  if (!memoryPressureInitialized) return;

  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    memoryPressureInitialized = false;
    log.info('Memory pressure handling cleaned up');
  }
}

/**
 * Evict oldest entries to make room for new data
 * Uses LRU eviction based on lastAccess time
 */
function evictCache(requiredSpace: number): void {
  // Only evict if we need space
  if (
    currentCacheSize + requiredSpace <= MAX_CACHE_SIZE &&
    photoCache.size < MAX_CACHE_ENTRIES
  ) {
    return;
  }

  // Sort entries by last access time (oldest first)
  const entries = Array.from(photoCache.entries()).sort(
    ([, a], [, b]) => a.lastAccess - b.lastAccess,
  );

  for (const [id, entry] of entries) {
    // Don't evict entries with active references
    if (entry.refCount > 0) continue;

    // Revoke blob URL and remove from cache
    URL.revokeObjectURL(entry.blobUrl);
    currentCacheSize -= entry.blob.size;
    photoCache.delete(id);

    // Check if we have enough space now
    if (
      currentCacheSize + requiredSpace <= MAX_CACHE_SIZE &&
      photoCache.size < MAX_CACHE_ENTRIES
    ) {
      break;
    }
  }
}

/**
 * Add a photo to the cache
 */
function cachePhoto(photoId: string, blob: Blob, blobUrl: string): CacheEntry {
  evictCache(blob.size);

  const entry: CacheEntry = {
    blobUrl,
    blob,
    refCount: 1,
    lastAccess: Date.now(),
  };

  photoCache.set(photoId, entry);
  currentCacheSize += blob.size;

  return entry;
}

// =============================================================================
// Photo Loading
// =============================================================================

/** Map of pending photo loads to prevent duplicate requests */
const pendingLoads = new Map<string, Promise<PhotoLoadResult>>();

/**
 * Error thrown when shard integrity verification fails
 */
export class ShardIntegrityError extends Error {
  constructor(
    public readonly shardId: string,
    public readonly expectedHash: string,
  ) {
    super(`Shard integrity check failed for ${shardId}: hash mismatch`);
    this.name = 'ShardIntegrityError';
  }
}

/**
 * Load and decrypt a photo from its encrypted shards
 *
 * @param photoId - Unique photo identifier
 * @param shardIds - Array of shard IDs that make up the photo
 * @param epochReadKey - Opaque epoch handle id for decryption
 * @param mimeType - The photo's MIME type (e.g., 'image/jpeg')
 * @param options - Loading options
 * @param shardHashes - Optional array of expected SHA256 hashes for integrity verification
 * @returns Photo load result with blob URL
 * @throws PhotoAssemblyError if loading fails
 * @throws ShardIntegrityError if hash verification fails
 */
export async function loadPhoto(
  photoId: string,
  shardIds: string[],
  epochReadKey: EpochHandleId,
  mimeType: string,
  options: PhotoLoadOptions = {},
  shardHashes?: string[],
): Promise<PhotoLoadResult> {
  const { onProgress, skipCache = false } = options;

  // Check cache first
  if (!skipCache) {
    const cached = photoCache.get(photoId);
    if (cached) {
      cached.refCount++;
      cached.lastAccess = Date.now();
      return {
        blobUrl: cached.blobUrl,
        mimeType,
        size: cached.blob.size,
      };
    }
  }

  // Check for pending load
  const pending = pendingLoads.get(photoId);
  if (pending && !skipCache) {
    return pending;
  }

  // Create load promise
  const loadPromise = (async (): Promise<PhotoLoadResult> => {
    try {
      // Download all shards
      const encryptedShards = await downloadShards(shardIds, onProgress);

      // Get crypto client
      const crypto = await getCryptoClient();

      // Verify and decrypt each shard
      const decryptedChunks: Uint8Array[] = [];
      for (let i = 0; i < encryptedShards.length; i++) {
        const shard = encryptedShards[i]!;
        const expectedHash = shardHashes?.[i];

        // Verify integrity if hash is available
        if (expectedHash) {
          const isValid = await crypto.verifyShard(shard, expectedHash);
          if (!isValid) {
            throw new ShardIntegrityError(shardIds[i]!, expectedHash);
          }
        }

        const plaintext = await crypto.decryptShardWithEpoch(
          epochReadKey,
          shard,
        );
        decryptedChunks.push(plaintext);
      }

      // Calculate total size
      const totalSize = decryptedChunks.reduce(
        (sum, chunk) => sum + chunk.length,
        0,
      );

      // Combine chunks into single array
      const photoData = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of decryptedChunks) {
        photoData.set(chunk, offset);
        offset += chunk.length;
      }

      // Create displayable URL (handles AVIF fallback for legacy browsers)
      const { url: blobUrl, mimeType: displayMimeType } =
        await createDisplayableUrl(photoData, mimeType);
      const blob = new Blob([photoData], { type: displayMimeType });

      // Cache the result
      if (!skipCache) {
        cachePhoto(photoId, blob, blobUrl);
      }

      return {
        blobUrl,
        mimeType: displayMimeType,
        size: blob.size,
      };
    } finally {
      pendingLoads.delete(photoId);
    }
  })();

  pendingLoads.set(photoId, loadPromise);
  return loadPromise;
}

/**
 * Release a reference to a cached photo
 * When refCount reaches 0, the blob URL may be evicted from cache
 *
 * @param photoId - The photo ID to release
 */
export function releasePhoto(photoId: string): void {
  const entry = photoCache.get(photoId);
  if (entry) {
    entry.refCount = Math.max(0, entry.refCount - 1);
  }
}

/**
 * Clear all cached photos and revoke blob URLs
 * Call this on logout or when freeing memory
 */
export function clearPhotoCache(): void {
  for (const entry of photoCache.values()) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  photoCache.clear();
  currentCacheSize = 0;
  // Also clear thumbnails when clearing photo cache
  clearThumbnailCache();
}

/**
 * Check if a photo is in the cache
 *
 * @param photoId - The photo ID to check
 * @returns true if the photo is cached
 */
export function isPhotoCached(photoId: string): boolean {
  return photoCache.has(photoId);
}

/**
 * Get a cached photo synchronously without triggering a load
 * Useful for checking if we can show a cached image immediately
 *
 * @param photoId - The photo ID to get
 * @returns The cached photo result, or null if not cached
 */
export function getCachedPhoto(photoId: string): PhotoLoadResult | null {
  const entry = photoCache.get(photoId);
  if (entry) {
    entry.refCount++;
    entry.lastAccess = Date.now();
    return {
      blobUrl: entry.blobUrl,
      mimeType: entry.blob.type,
      size: entry.blob.size,
    };
  }
  return null;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  entries: number;
  sizeBytes: number;
  maxSizeBytes: number;
} {
  return {
    entries: photoCache.size,
    sizeBytes: currentCacheSize,
    maxSizeBytes: MAX_CACHE_SIZE,
  };
}

/**
 * Preload photos into cache
 * Useful for preloading visible photos in a virtualized list
 *
 * @param photos - Array of photo info to preload
 * @param epochReadKey - Opaque epoch handle id for decryption
 */
export async function preloadPhotos(
  photos: Array<{ id: string; shardIds: string[]; mimeType: string }>,
  epochReadKey: EpochHandleId,
): Promise<void> {
  // Load in parallel but don't wait for all
  const loads = photos.map(async (photo) => {
    try {
      await loadPhoto(photo.id, photo.shardIds, epochReadKey, photo.mimeType);
      releasePhoto(photo.id); // Release since preload doesn't hold reference
    } catch (error) {
      // Ignore errors during preload
      log.error(`Preload failed for photo ${photo.id}`, error);
    }
  });

  await Promise.allSettled(loads);
}

// =============================================================================
// Thumbnail Loading
// =============================================================================

/** Cache for thumbnail blob URLs */
const thumbnailCache = new Map<string, CacheEntry>();

/** Current thumbnail cache size in bytes */
let thumbnailCacheSize = 0;

/** Maximum thumbnail cache size (20MB - smaller than full photos) */
const MAX_THUMBNAIL_CACHE_SIZE = 20 * 1024 * 1024;

/**
 * Reduce thumbnail cache to a fraction of max size.
 * Called by memory pressure handling when tab is backgrounded.
 *
 * @param ratio - Target ratio (0.0 to 1.0) of max cache size
 */
function reduceThumbnailCacheToRatio(ratio: number): void {
  const targetSize = Math.floor(MAX_THUMBNAIL_CACHE_SIZE * ratio);

  log.info(
    `Reducing thumbnail cache to ${Math.round(ratio * 100)}% (target: ${targetSize} bytes)`,
  );

  const entries = Array.from(thumbnailCache.entries()).sort(
    ([, a], [, b]) => a.lastAccess - b.lastAccess,
  );

  for (const [id, entry] of entries) {
    if (thumbnailCacheSize <= targetSize) break;
    if (entry.refCount > 0) continue;

    URL.revokeObjectURL(entry.blobUrl);
    thumbnailCacheSize -= entry.blob.size;
    thumbnailCache.delete(id);
  }

  log.info(
    `Thumbnail cache reduced: entries=${thumbnailCache.size}, size=${thumbnailCacheSize} bytes`,
  );
}

/**
 * Evict oldest thumbnail entries to make room for new data
 */
function evictThumbnailCache(requiredSpace: number): void {
  if (
    thumbnailCacheSize + requiredSpace <= MAX_THUMBNAIL_CACHE_SIZE &&
    thumbnailCache.size < MAX_CACHE_ENTRIES
  ) {
    return;
  }

  const entries = Array.from(thumbnailCache.entries()).sort(
    ([, a], [, b]) => a.lastAccess - b.lastAccess,
  );

  for (const [id, entry] of entries) {
    if (entry.refCount > 0) continue;

    URL.revokeObjectURL(entry.blobUrl);
    thumbnailCacheSize -= entry.blob.size;
    thumbnailCache.delete(id);

    if (
      thumbnailCacheSize + requiredSpace <= MAX_THUMBNAIL_CACHE_SIZE &&
      thumbnailCache.size < MAX_CACHE_ENTRIES
    ) {
      break;
    }
  }
}

/**
 * Load a thumbnail from embedded base64 data in photo metadata
 *
 * This is the fast path for gallery view - no network requests needed
 * since the thumbnail is already embedded in the manifest metadata.
 *
 * @param photoId - Unique photo identifier
 * @param thumbnailBase64 - Base64-encoded JPEG thumbnail
 * @returns Thumbnail load result with blob URL
 */
export function loadThumbnailFromBase64(
  photoId: string,
  thumbnailBase64: string,
): PhotoLoadResult {
  const cacheKey = `thumb:${photoId}`;

  // Check cache first
  const cached = thumbnailCache.get(cacheKey);
  if (cached) {
    cached.refCount++;
    cached.lastAccess = Date.now();
    return {
      blobUrl: cached.blobUrl,
      mimeType: 'image/jpeg',
      size: cached.blob.size,
    };
  }

  // Decode base64 to bytes
  const bytes = base64ToUint8Array(thumbnailBase64);

  // Create blob and URL - copy bytes to new ArrayBuffer for Blob compatibility
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: 'image/jpeg' });
  const blobUrl = URL.createObjectURL(blob);

  // Cache the result
  evictThumbnailCache(blob.size);
  const entry: CacheEntry = {
    blobUrl,
    blob,
    refCount: 1,
    lastAccess: Date.now(),
  };
  thumbnailCache.set(cacheKey, entry);
  thumbnailCacheSize += blob.size;

  return {
    blobUrl,
    mimeType: 'image/jpeg',
    size: blob.size,
  };
}

/**
 * Release a reference to a cached thumbnail
 *
 * @param photoId - The photo ID to release thumbnail for
 */
export function releaseThumbnail(photoId: string): void {
  const cacheKey = `thumb:${photoId}`;
  const entry = thumbnailCache.get(cacheKey);
  if (entry) {
    entry.refCount = Math.max(0, entry.refCount - 1);
  }
}

/**
 * Clear all cached thumbnails
 */
export function clearThumbnailCache(): void {
  for (const entry of thumbnailCache.values()) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  thumbnailCache.clear();
  thumbnailCacheSize = 0;
}

/**
 * Get thumbnail cache statistics
 */
export function getThumbnailCacheStats(): {
  entries: number;
  sizeBytes: number;
  maxSizeBytes: number;
} {
  return {
    entries: thumbnailCache.size,
    sizeBytes: thumbnailCacheSize,
    maxSizeBytes: MAX_THUMBNAIL_CACHE_SIZE,
  };
}
