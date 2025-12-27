/**
 * Epoch Key Store
 *
 * In-memory cache for unwrapped epoch keys per album.
 * Keys are cleared on logout for security.
 */

/** Unwrapped epoch key bundle containing read and sign keys */
export interface EpochKeyBundle {
  epochId: number;
  readKey: Uint8Array;
  signKeypair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
}

/** Cache structure: albumId -> epochId -> EpochKeyBundle */
const epochKeyCache = new Map<string, Map<number, EpochKeyBundle>>();

/**
 * Get an epoch key bundle from the cache.
 *
 * @param albumId - Album ID
 * @param epochId - Epoch ID
 * @returns Epoch key bundle if cached, null otherwise
 */
export function getEpochKey(
  albumId: string,
  epochId: number
): EpochKeyBundle | null {
  const albumKeys = epochKeyCache.get(albumId);
  return albumKeys?.get(epochId) ?? null;
}

/**
 * Get the current (highest) epoch key for an album.
 *
 * @param albumId - Album ID
 * @returns Current epoch key bundle if any cached, null otherwise
 */
export function getCurrentEpochKey(albumId: string): EpochKeyBundle | null {
  const albumKeys = epochKeyCache.get(albumId);
  if (!albumKeys || albumKeys.size === 0) {
    return null;
  }

  // Find the highest epoch ID
  let maxEpochId = -1;
  let currentBundle: EpochKeyBundle | null = null;

  for (const [epochId, bundle] of albumKeys) {
    if (epochId > maxEpochId) {
      maxEpochId = epochId;
      currentBundle = bundle;
    }
  }

  return currentBundle;
}

/**
 * Store an epoch key bundle in the cache.
 *
 * @param albumId - Album ID
 * @param bundle - Epoch key bundle to cache
 */
export function setEpochKey(albumId: string, bundle: EpochKeyBundle): void {
  let albumKeys = epochKeyCache.get(albumId);
  if (!albumKeys) {
    albumKeys = new Map();
    epochKeyCache.set(albumId, albumKeys);
  }
  albumKeys.set(bundle.epochId, bundle);
}

/**
 * Check if an epoch key is cached.
 *
 * @param albumId - Album ID
 * @param epochId - Epoch ID
 * @returns true if key is cached
 */
export function hasEpochKey(albumId: string, epochId: number): boolean {
  const albumKeys = epochKeyCache.get(albumId);
  return albumKeys?.has(epochId) ?? false;
}

/**
 * Get all cached epoch IDs for an album.
 *
 * @param albumId - Album ID
 * @returns Array of cached epoch IDs
 */
export function getCachedEpochIds(albumId: string): number[] {
  const albumKeys = epochKeyCache.get(albumId);
  return albumKeys ? Array.from(albumKeys.keys()) : [];
}

/**
 * Clear all cached keys for a specific album.
 *
 * @param albumId - Album ID
 */
export function clearAlbumKeys(albumId: string): void {
  const albumKeys = epochKeyCache.get(albumId);
  if (albumKeys) {
    // Wipe key material before clearing
    for (const bundle of albumKeys.values()) {
      bundle.readKey.fill(0);
      bundle.signKeypair.secretKey.fill(0);
    }
    albumKeys.clear();
    epochKeyCache.delete(albumId);
  }
}

/**
 * Clear all cached epoch keys.
 * Call on logout to ensure keys are wiped from memory.
 */
export function clearAllEpochKeys(): void {
  // Wipe all key material before clearing
  for (const albumKeys of epochKeyCache.values()) {
    for (const bundle of albumKeys.values()) {
      bundle.readKey.fill(0);
      bundle.signKeypair.secretKey.fill(0);
    }
    albumKeys.clear();
  }
  epochKeyCache.clear();
}

/**
 * Get total number of cached keys (for debugging/testing).
 *
 * @returns Total number of cached epoch keys across all albums
 */
export function getCacheSize(): number {
  let total = 0;
  for (const albumKeys of epochKeyCache.values()) {
    total += albumKeys.size;
  }
  return total;
}
