/**
 * Album Cover Service
 *
 * Fetches and caches cover photo thumbnails for albums.
 * The cover photo is the first photo in the album (by taken_at date).
 */

import type { PhotoMeta } from '../workers/types';
import { getDbClient } from './db-client';
import { loadPhoto, releasePhoto } from './photo-service';

/**
 * Error thrown when album cover operations fail
 */
export class AlbumCoverError extends Error {
  constructor(
    message: string,
    public readonly albumId: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AlbumCoverError';
  }
}

/**
 * Album cover result
 */
export interface AlbumCover {
  /** Blob URL for the cover image */
  blobUrl: string;
  /** Photo ID used as cover */
  photoId: string;
  /** MIME type of the cover image */
  mimeType: string;
}

/** In-memory cache for album covers (albumId -> AlbumCover) */
const coverCache = new Map<string, AlbumCover>();

/** Pending cover loads to prevent duplicate requests */
const pendingLoads = new Map<string, Promise<AlbumCover | null>>();

/**
 * Get the first photo in an album (by date).
 * This photo will be used as the album cover.
 *
 * @param albumId - Album ID
 * @returns First photo or null if album is empty
 */
export async function getFirstPhotoForAlbum(
  albumId: string
): Promise<PhotoMeta | null> {
  try {
    const db = await getDbClient();
    // getPhotos returns photos sorted by taken_at DESC, created_at DESC
    // We want the first (most recent) photo for the cover
    const photos = await db.getPhotos(albumId, 1, 0);
    return photos[0] ?? null;
  } catch (err) {
    throw new AlbumCoverError(
      `Failed to get first photo for album: ${err instanceof Error ? err.message : String(err)}`,
      albumId,
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Get album cover photo, loading and decrypting if necessary.
 * Returns null if album has no photos.
 *
 * @param albumId - Album ID
 * @param epochReadKey - Epoch read key for decryption (32 bytes)
 * @returns Album cover or null if no photos
 * @throws AlbumCoverError if loading fails
 */
export async function getAlbumCover(
  albumId: string,
  epochReadKey: Uint8Array
): Promise<AlbumCover | null> {
  // Check cache first
  const cached = coverCache.get(albumId);
  if (cached) {
    return cached;
  }

  // Check for pending load
  const pending = pendingLoads.get(albumId);
  if (pending) {
    return pending;
  }

  // Create load promise
  const loadPromise = (async (): Promise<AlbumCover | null> => {
    try {
      // Get first photo
      const firstPhoto = await getFirstPhotoForAlbum(albumId);
      if (!firstPhoto) {
        return null; // Album has no photos
      }

      // Check if photo has shards
      if (!firstPhoto.shardIds || firstPhoto.shardIds.length === 0) {
        throw new AlbumCoverError(
          'First photo has no shard IDs',
          albumId
        );
      }

      // Load and decrypt the photo
      const result = await loadPhoto(
        firstPhoto.id,
        firstPhoto.shardIds,
        epochReadKey,
        firstPhoto.mimeType
      );

      const cover: AlbumCover = {
        blobUrl: result.blobUrl,
        photoId: firstPhoto.id,
        mimeType: result.mimeType,
      };

      // Cache the result
      coverCache.set(albumId, cover);

      return cover;
    } finally {
      pendingLoads.delete(albumId);
    }
  })();

  pendingLoads.set(albumId, loadPromise);
  return loadPromise;
}

/**
 * Get cached album cover without loading.
 *
 * @param albumId - Album ID
 * @returns Cached cover or null if not cached
 */
export function getCachedCover(albumId: string): AlbumCover | null {
  return coverCache.get(albumId) ?? null;
}

/**
 * Release an album cover and remove from cache.
 * Revokes the blob URL to free memory.
 *
 * @param albumId - Album ID
 */
export function releaseCover(albumId: string): void {
  const cover = coverCache.get(albumId);
  if (cover) {
    // Release the photo reference
    releasePhoto(cover.photoId);
    coverCache.delete(albumId);
  }
}

/**
 * Clear all cached album covers.
 * Should be called on logout.
 */
export function clearAllCovers(): void {
  for (const cover of coverCache.values()) {
    releasePhoto(cover.photoId);
  }
  coverCache.clear();
}

/**
 * Check if an album has a cached cover.
 *
 * @param albumId - Album ID
 * @returns True if cover is cached
 */
export function hasCachedCover(albumId: string): boolean {
  return coverCache.has(albumId);
}

/**
 * Get the number of cached covers (for diagnostics).
 */
export function getCoverCacheSize(): number {
  return coverCache.size;
}
