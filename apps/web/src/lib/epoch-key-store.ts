/**
 * Epoch Key Store
 *
 * Per-album cache of opaque epoch handle ids. The crypto worker holds the
 * actual key material; this module only stores the (album, epoch) → handle
 * binding plus the per-epoch sign verifying key (public, safe to expose).
 *
 * Slice 3 — wipeBundle is replaced with `closeHandle`, which asks the
 * crypto worker to release the underlying Rust handle. Cache entries no
 * longer carry secret bytes; logout simply closes every handle and drops
 * the map.
 */

import { getCryptoClient } from './crypto-client';
import { createLogger } from './logger';

const log = createLogger('EpochKeyStore');

/**
 * Cached epoch key reference.
 *
 * Slice 3 — the AUTHORITATIVE fields are `epochHandleId` and
 * `signPublicKey`. Secret material — the epoch seed and per-epoch sign
 * secret — never leaves the worker. The legacy `epochSeed` and
 * `signKeypair` fields are kept as zero-filled transitional placeholders
 * so Slice 4-7 callers (manifest, sync, share links, album content, upload)
 * still typecheck during the multi-slice cutover; those slices migrate the
 * call sites to use `epochHandleId` and remove the placeholders. Reading
 * the placeholder bytes will produce garbage and is treated as a Slice
 * 4-7 migration bug, not a runtime expectation.
 */
export interface EpochKeyBundle {
  epochId: number;
  /** Opaque crypto-worker handle id; consumed via worker methods only. */
  epochHandleId: string;
  /** 32-byte Ed25519 manifest signing public key. */
  signPublicKey: Uint8Array;
  /**
   * @deprecated Slice 3 cutover placeholder. Always an empty `Uint8Array`.
   * Consumers must migrate to handle-based worker methods that take
   * `epochHandleId`. Removal is tracked alongside Slices 4-7.
   */
  epochSeed: Uint8Array;
  /**
   * @deprecated Slice 3 cutover placeholder. `publicKey` mirrors
   * `signPublicKey`; `secretKey` is always an empty `Uint8Array` because
   * the per-epoch sign secret never crosses the Comlink boundary.
   */
  signKeypair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
}

const EMPTY_BYTES: Uint8Array = new Uint8Array(0);

/** Cache structure: albumId -> epochId -> EpochKeyBundle */
const epochKeyCache = new Map<string, Map<number, EpochKeyBundle>>();

/**
 * Closes the underlying Rust epoch handle behind the cache entry. Errors
 * are logged but not propagated — `closeEpochHandle` is idempotent and a
 * stale handle just means the worker has already released it.
 */
async function closeHandle(bundle: EpochKeyBundle): Promise<void> {
  try {
    const crypto = await getCryptoClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await crypto.closeEpochHandle(bundle.epochHandleId as any);
  } catch (err) {
    log.warn('closeEpochHandle rejected during cache cleanup', {
      albumId: '<unknown>',
      epochId: bundle.epochId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Get an epoch key bundle from the cache.
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
 */
export function getCurrentEpochKey(albumId: string): EpochKeyBundle | null {
  const albumKeys = epochKeyCache.get(albumId);
  if (!albumKeys || albumKeys.size === 0) {
    return null;
  }

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
 * Store an epoch key bundle in the cache. If an entry already exists for
 * `(albumId, bundle.epochId)`, its underlying handle is closed before being
 * replaced so old Rust handles do not leak.
 *
 * Callers may supply only the authoritative fields, only the deprecated
 * fields, or both; the deprecated placeholders are normalised to empty
 * buffers automatically. Slice 4-7 callers that still construct legacy
 * `{ epochSeed, signKeypair }` shapes continue to typecheck during the
 * cutover even though their stored entries will lack a real handle id
 * until those slices migrate the call sites.
 */
export function setEpochKey(
  albumId: string,
  bundle: {
    epochId: number;
    epochHandleId?: string;
    signPublicKey?: Uint8Array;
    /**
     * @deprecated Slice 3 placeholder accepted for transitional callers in
     * Slice 4-7 territory.
     */
    epochSeed?: Uint8Array;
    /**
     * @deprecated Slice 3 placeholder accepted for transitional callers in
     * Slice 4-7 territory.
     */
    signKeypair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  },
): void {
  let albumKeys = epochKeyCache.get(albumId);
  if (!albumKeys) {
    albumKeys = new Map();
    epochKeyCache.set(albumId, albumKeys);
  }

  const signPublicKey =
    bundle.signPublicKey ?? bundle.signKeypair?.publicKey ?? EMPTY_BYTES;

  const normalised: EpochKeyBundle = {
    epochId: bundle.epochId,
    epochHandleId: bundle.epochHandleId ?? '',
    signPublicKey,
    epochSeed: EMPTY_BYTES,
    signKeypair: {
      publicKey: signPublicKey,
      secretKey: EMPTY_BYTES,
    },
  };

  const existing = albumKeys.get(normalised.epochId);
  if (existing && existing.epochHandleId !== normalised.epochHandleId) {
    void closeHandle(existing);
  }

  albumKeys.set(normalised.epochId, normalised);
}

/**
 * Check if an epoch key is cached.
 */
export function hasEpochKey(albumId: string, epochId: number): boolean {
  const albumKeys = epochKeyCache.get(albumId);
  return albumKeys?.has(epochId) ?? false;
}

/**
 * Get all cached epoch IDs for an album.
 */
export function getCachedEpochIds(albumId: string): number[] {
  const albumKeys = epochKeyCache.get(albumId);
  return albumKeys ? Array.from(albumKeys.keys()) : [];
}

/**
 * Clear all cached keys for a specific album.
 *
 * Each cached handle is closed asynchronously; the cache is dropped
 * synchronously so subsequent lookups miss immediately.
 */
export function clearAlbumKeys(albumId: string): void {
  const albumKeys = epochKeyCache.get(albumId);
  if (albumKeys) {
    for (const bundle of albumKeys.values()) {
      void closeHandle(bundle);
    }
    albumKeys.clear();
    epochKeyCache.delete(albumId);
  }
}

/**
 * Clear all cached epoch keys. Call on logout to ensure every Rust handle
 * is released.
 */
export function clearAllEpochKeys(): void {
  for (const albumKeys of epochKeyCache.values()) {
    for (const bundle of albumKeys.values()) {
      void closeHandle(bundle);
    }
    albumKeys.clear();
  }
  epochKeyCache.clear();
}

/**
 * Get total number of cached handles (for debugging/testing).
 */
export function getCacheSize(): number {
  let total = 0;
  for (const albumKeys of epochKeyCache.values()) {
    total += albumKeys.size;
  }
  return total;
}
