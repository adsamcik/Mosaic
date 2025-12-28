/**
 * Epoch Key Service
 *
 * Fetches, verifies, and unwraps epoch key bundles from the server.
 * Uses crypto worker for cryptographic operations.
 */

import { fromBase64, getApi } from './api';
import type { EpochKeyRecord } from './api-types';
import { getCryptoClient } from './crypto-client';
import {
    getCurrentEpochKey,
    getEpochKey,
    hasEpochKey,
    setEpochKey,
    type EpochKeyBundle,
} from './epoch-key-store';
import { createLogger } from './logger';

const log = createLogger('epoch-key-service');

/** Error thrown when epoch key operations fail */
export class EpochKeyError extends Error {
  constructor(
    message: string,
    public readonly code: EpochKeyErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EpochKeyError';
  }
}

/** Epoch key error codes */
export enum EpochKeyErrorCode {
  /** Failed to fetch epoch keys from server */
  FETCH_FAILED = 'FETCH_FAILED',
  /** No epoch keys available for album */
  NO_KEYS_AVAILABLE = 'NO_KEYS_AVAILABLE',
  /** Identity keypair not derived yet */
  IDENTITY_NOT_DERIVED = 'IDENTITY_NOT_DERIVED',
  /** Signature verification failed */
  SIGNATURE_INVALID = 'SIGNATURE_INVALID',
  /** Failed to decrypt the sealed box */
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  /** Epoch key context mismatch */
  CONTEXT_MISMATCH = 'CONTEXT_MISMATCH',
}

/**
 * Fetch and unwrap epoch keys for an album.
 *
 * This function:
 * 1. Fetches encrypted epoch key bundles from the server
 * 2. Verifies owner signatures using crypto worker
 * 3. Opens sealed boxes using identity keypair
 * 4. Caches unwrapped keys in epoch-key-store
 *
 * @param albumId - Album ID to fetch keys for
 * @param minEpochId - Minimum epoch ID to accept (default 0)
 * @returns Array of unwrapped epoch key bundles
 * @throws EpochKeyError if fetch or unwrap fails
 */
export async function fetchAndUnwrapEpochKeys(
  albumId: string,
  minEpochId = 0
): Promise<EpochKeyBundle[]> {
  const api = getApi();
  const crypto = await getCryptoClient();

  // Ensure identity is derived before attempting to open sealed boxes
  const identityPubkey = await crypto.getIdentityPublicKey();
  if (!identityPubkey) {
    // Try to derive identity first
    try {
      await crypto.deriveIdentity();
    } catch (err) {
      throw new EpochKeyError(
        'Identity keypair not derived - cannot open epoch key bundles',
        EpochKeyErrorCode.IDENTITY_NOT_DERIVED,
        err instanceof Error ? err : undefined
      );
    }
  }

  // Fetch epoch keys from server
  let epochKeyRecords: EpochKeyRecord[];
  try {
    epochKeyRecords = await api.getEpochKeys(albumId);
  } catch (err) {
    throw new EpochKeyError(
      `Failed to fetch epoch keys for album ${albumId}`,
      EpochKeyErrorCode.FETCH_FAILED,
      err instanceof Error ? err : undefined
    );
  }

  if (epochKeyRecords.length === 0) {
    throw new EpochKeyError(
      `No epoch keys available for album ${albumId}`,
      EpochKeyErrorCode.NO_KEYS_AVAILABLE
    );
  }

  const unwrappedBundles: EpochKeyBundle[] = [];

  // Unwrap each epoch key bundle
  for (const record of epochKeyRecords) {
    // Skip epochs below minimum (prevents replay attacks)
    if (record.epochId < minEpochId) {
      continue;
    }

    // Check if already cached
    if (hasEpochKey(albumId, record.epochId)) {
      const cached = getEpochKey(albumId, record.epochId);
      if (cached) {
        unwrappedBundles.push(cached);
        continue;
      }
    }

    try {
      // Decode base64 values from server
      // Note: encryptedKeyBundle is stored as signature (64 bytes) || sealed box
      // so we use it directly - no need to prepend ownerSignature again
      const fullBundle = fromBase64(record.encryptedKeyBundle);
      const sharerPubkey = fromBase64(record.sharerPubkey);

      // Open the epoch key bundle via crypto worker
      const opened = await crypto.openEpochKeyBundle(
        fullBundle,
        sharerPubkey,
        albumId,
        minEpochId
      );

      const bundle: EpochKeyBundle = {
        epochId: record.epochId,
        epochSeed: opened.epochSeed,
        signKeypair: {
          publicKey: opened.signPublicKey,
          secretKey: opened.signSecretKey,
        },
      };

      // Cache the unwrapped bundle
      setEpochKey(albumId, bundle);
      unwrappedBundles.push(bundle);
    } catch (err) {
      // Determine error type based on message
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('signature') || message.includes('Signature')) {
        throw new EpochKeyError(
          `Invalid signature for epoch key ${record.epochId}`,
          EpochKeyErrorCode.SIGNATURE_INVALID,
          err instanceof Error ? err : undefined
        );
      }

      if (message.includes('decrypt') || message.includes('open')) {
        throw new EpochKeyError(
          `Failed to decrypt epoch key ${record.epochId}`,
          EpochKeyErrorCode.DECRYPTION_FAILED,
          err instanceof Error ? err : undefined
        );
      }

      if (message.includes('mismatch') || message.includes('context')) {
        throw new EpochKeyError(
          `Context mismatch for epoch key ${record.epochId}`,
          EpochKeyErrorCode.CONTEXT_MISMATCH,
          err instanceof Error ? err : undefined
        );
      }

      // Re-throw unknown errors
      throw err;
    }
  }

  return unwrappedBundles;
}

/**
 * Get epoch key for an album, fetching from server if not cached.
 *
 * @param albumId - Album ID
 * @param epochId - Specific epoch ID to get
 * @returns Epoch key bundle
 * @throws EpochKeyError if key not available
 */
export async function getOrFetchEpochKey(
  albumId: string,
  epochId: number
): Promise<EpochKeyBundle> {
  // Check cache first
  const cached = getEpochKey(albumId, epochId);
  if (cached) {
    return cached;
  }

  // Fetch and unwrap all epoch keys for album
  await fetchAndUnwrapEpochKeys(albumId);

  // Check cache again
  const bundle = getEpochKey(albumId, epochId);
  if (!bundle) {
    throw new EpochKeyError(
      `Epoch key ${epochId} not found for album ${albumId}`,
      EpochKeyErrorCode.NO_KEYS_AVAILABLE
    );
  }

  return bundle;
}

/**
 * Get the current (latest) epoch key for an album.
 * Fetches from server if no keys are cached.
 *
 * @param albumId - Album ID
 * @returns Current epoch key bundle
 * @throws EpochKeyError if no keys available
 */
export async function getCurrentOrFetchEpochKey(
  albumId: string
): Promise<EpochKeyBundle> {
  // Check cache first
  let current = getCurrentEpochKey(albumId);
  if (current) {
    return current;
  }

  // Fetch and unwrap all epoch keys for album
  await fetchAndUnwrapEpochKeys(albumId);

  // Get current from cache
  current = getCurrentEpochKey(albumId);
  if (!current) {
    throw new EpochKeyError(
      `No epoch keys available for album ${albumId}`,
      EpochKeyErrorCode.NO_KEYS_AVAILABLE
    );
  }

  return current;
}

/**
 * Ensure epoch keys are loaded for an album.
 * Silently succeeds if keys are already cached.
 * Use before sync or photo operations that need epoch keys.
 *
 * @param albumId - Album ID
 * @returns true if keys were loaded (or already cached)
 */
export async function ensureEpochKeysLoaded(albumId: string): Promise<boolean> {
  // If we have any keys cached, assume we have what we need
  const current = getCurrentEpochKey(albumId);
  if (current) {
    return true;
  }

  try {
    await fetchAndUnwrapEpochKeys(albumId);
    return true;
  } catch (err) {
    log.error(`Failed to load epoch keys for album ${albumId}:`, err);
    return false;
  }
}
