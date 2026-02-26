/**
 * Epoch Key Store
 *
 * In-memory cache for unwrapped epoch keys per album.
 * Keys are cleared on logout for security.
 */

import { memzero } from '@mosaic/crypto';
import { createLogger } from './logger';

const log = createLogger('EpochKeyStore');

/** Unwrapped epoch key bundle containing seed and sign keys */
export interface EpochKeyBundle {
  epochId: number;
  /** 32-byte epoch seed for deriving tier keys */
  epochSeed: Uint8Array;
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
  epochId: number,
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
 * IMPORTANT: This function preserves existing signKeypair data if the new bundle
 * has empty (all zeros) signKeypair but an existing bundle has valid data.
 * This prevents race conditions where hooks that only have epochSeed overwrite
 * complete bundles stored by fetchAndUnwrapEpochKeys.
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

  // Check if we already have a bundle with valid signKeypair
  const existing = albumKeys.get(bundle.epochId);
  if (existing) {
    const existingHasValidSignKeypair = existing.signKeypair.publicKey.some(
      (b) => b !== 0,
    );
    const newHasValidSignKeypair = bundle.signKeypair.publicKey.some(
      (b) => b !== 0,
    );

    // Don't overwrite a complete bundle with one that has empty signKeypair
    if (existingHasValidSignKeypair && !newHasValidSignKeypair) {
      // Preserve existing, but update epochSeed if the new one is different
      // (in case the seed was updated but signKeypair wasn't provided)
      const seedsMatch = existing.epochSeed.every(
        (b, i) => b === bundle.epochSeed[i],
      );
      if (seedsMatch) {
        // Same seed, existing has better data - keep it
        return;
      }
      // Different seed with no signKeypair - this shouldn't happen, but log it
      log.warn('Overwriting epoch with different seed but empty signKeypair', {
        epochId: bundle.epochId,
      });
    }
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
      memzero(bundle.epochSeed);
      memzero(bundle.signKeypair.secretKey);
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
      memzero(bundle.epochSeed);
      memzero(bundle.signKeypair.secretKey);
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
