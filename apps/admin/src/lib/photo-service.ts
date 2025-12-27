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
 */

import { getCryptoClient } from './crypto-client';
import { downloadShards, type ProgressCallback } from './shard-service';

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
    public readonly cause: Error
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
    ([, a], [, b]) => a.lastAccess - b.lastAccess
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
 * Load and decrypt a photo from its encrypted shards
 *
 * @param photoId - Unique photo identifier
 * @param shardIds - Array of shard IDs that make up the photo
 * @param epochReadKey - The epoch read key for decryption
 * @param mimeType - The photo's MIME type (e.g., 'image/jpeg')
 * @param options - Loading options
 * @returns Photo load result with blob URL
 * @throws PhotoAssemblyError if loading fails
 */
export async function loadPhoto(
  photoId: string,
  shardIds: string[],
  epochReadKey: Uint8Array,
  mimeType: string,
  options: PhotoLoadOptions = {}
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

      // Decrypt each shard
      const decryptedChunks: Uint8Array[] = [];
      for (const shard of encryptedShards) {
        const plaintext = await crypto.decryptShard(shard, epochReadKey);
        decryptedChunks.push(plaintext);
      }

      // Calculate total size
      const totalSize = decryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0);

      // Combine chunks into single array
      const photoData = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of decryptedChunks) {
        photoData.set(chunk, offset);
        offset += chunk.length;
      }

      // Create blob and URL
      const blob = new Blob([photoData], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      // Cache the result
      if (!skipCache) {
        cachePhoto(photoId, blob, blobUrl);
      }

      return {
        blobUrl,
        mimeType,
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
 * @param epochReadKey - Epoch read key for decryption
 */
export async function preloadPhotos(
  photos: Array<{ id: string; shardIds: string[]; mimeType: string }>,
  epochReadKey: Uint8Array
): Promise<void> {
  // Load in parallel but don't wait for all
  const loads = photos.map(async (photo) => {
    try {
      await loadPhoto(photo.id, photo.shardIds, epochReadKey, photo.mimeType);
      releasePhoto(photo.id); // Release since preload doesn't hold reference
    } catch (error) {
      // Ignore errors during preload
      console.warn(`Preload failed for photo ${photo.id}:`, error);
    }
  });

  await Promise.allSettled(loads);
}
