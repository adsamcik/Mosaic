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

const log = createLogger('EpochKeyService');

export interface FetchEpochKeyOptions {
  allowLegacyEmptyAlbumId?: boolean;
}

function newestRecordFirst(a: EpochKeyRecord, b: EpochKeyRecord): number {
  if (a.epochId !== b.epochId) {
    return b.epochId - a.epochId;
  }

  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  if (Number.isNaN(aCreated) || Number.isNaN(bCreated)) {
    return 0;
  }

  return bCreated - aCreated;
}

function isLegacyEmptyAlbumIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Bundle albumId must not be empty');
}

function classifyEpochKeyError(
  record: EpochKeyRecord,
  error: unknown,
): never {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('signature') || message.includes('Signature')) {
    throw new EpochKeyError(
      `Invalid signature for epoch key ${record.epochId}`,
      EpochKeyErrorCode.SIGNATURE_INVALID,
      error instanceof Error ? error : undefined,
    );
  }

  if (message.includes('decrypt') || message.includes('open')) {
    throw new EpochKeyError(
      `Failed to decrypt epoch key ${record.epochId}`,
      EpochKeyErrorCode.DECRYPTION_FAILED,
      error instanceof Error ? error : undefined,
    );
  }

  if (message.includes('mismatch') || message.includes('context')) {
    throw new EpochKeyError(
      `Context mismatch for epoch key ${record.epochId}`,
      EpochKeyErrorCode.CONTEXT_MISMATCH,
      error instanceof Error ? error : undefined,
    );
  }

  throw error;
}

/** Error thrown when epoch key operations fail */
export class EpochKeyError extends Error {
  constructor(
    message: string,
    public readonly code: EpochKeyErrorCode,
    public readonly cause?: Error,
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
  minEpochId = 0,
  options: FetchEpochKeyOptions = {},
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
        err instanceof Error ? err : undefined,
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
      err instanceof Error ? err : undefined,
    );
  }

  if (epochKeyRecords.length === 0) {
    throw new EpochKeyError(
      `No epoch keys available for album ${albumId}`,
      EpochKeyErrorCode.NO_KEYS_AVAILABLE,
    );
  }

  const unwrappedBundles: EpochKeyBundle[] = [];
  const seenEpochIds = new Set<number>();
  const recordsByEpoch = new Map<number, EpochKeyRecord[]>();

  for (const record of [...epochKeyRecords].sort(newestRecordFirst)) {
    if (record.epochId < minEpochId) {
      continue;
    }

    const records = recordsByEpoch.get(record.epochId);
    if (records) {
      records.push(record);
    } else {
      recordsByEpoch.set(record.epochId, [record]);
    }
  }

  for (const [epochId, records] of recordsByEpoch) {
    const primaryRecord = records[0];
    if (!primaryRecord) {
      continue;
    }

    if (seenEpochIds.has(epochId)) {
      continue;
    }

    if (hasEpochKey(albumId, epochId)) {
      const cached = getEpochKey(albumId, epochId);
      if (cached) {
        unwrappedBundles.push(cached);
        seenEpochIds.add(epochId);
        continue;
      }
    }

    let firstError: unknown = null;
    const legacyCandidates: EpochKeyRecord[] = [];
    const allowLegacyEmptyAlbumId = options.allowLegacyEmptyAlbumId ?? false;
    let hasNonLegacyRecord = false;
    let resolvedBundle: EpochKeyBundle | null = null;

    for (const record of records) {
      try {
        const fullBundle = fromBase64(record.encryptedKeyBundle);
        const sharerPubkey = fromBase64(record.sharerPubkey);
        const opened = await crypto.openEpochKeyBundle(
          fullBundle,
          sharerPubkey,
          albumId,
          minEpochId,
        );

        resolvedBundle = {
          epochId: record.epochId,
          epochSeed: opened.epochSeed,
          signKeypair: {
            publicKey: opened.signPublicKey,
            secretKey: opened.signSecretKey,
          },
        };
        break;
      } catch (error) {
        if (isLegacyEmptyAlbumIdError(error)) {
          if (allowLegacyEmptyAlbumId) {
            legacyCandidates.push(record);
          }
          firstError ??= error;
          continue;
        }

        hasNonLegacyRecord = true;
        firstError ??= error;
      }
    }

    if (
      !resolvedBundle &&
      allowLegacyEmptyAlbumId &&
      !hasNonLegacyRecord
    ) {
      for (const record of legacyCandidates) {
        try {
          const fullBundle = fromBase64(record.encryptedKeyBundle);
          const sharerPubkey = fromBase64(record.sharerPubkey);
          const opened = await crypto.openEpochKeyBundle(
            fullBundle,
            sharerPubkey,
            albumId,
            minEpochId,
            { allowLegacyEmptyAlbumId: true },
          );

          resolvedBundle = {
            epochId: record.epochId,
            epochSeed: opened.epochSeed,
            signKeypair: {
              publicKey: opened.signPublicKey,
              secretKey: opened.signSecretKey,
            },
          };
          break;
        } catch (error) {
          firstError ??= error;
        }
      }
    }

    if (!resolvedBundle) {
      classifyEpochKeyError(primaryRecord, firstError);
    }

    setEpochKey(albumId, resolvedBundle);
    unwrappedBundles.push(resolvedBundle);
    seenEpochIds.add(epochId);
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
  epochId: number,
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
      EpochKeyErrorCode.NO_KEYS_AVAILABLE,
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
  albumId: string,
): Promise<EpochKeyBundle> {
  // Check cache first
  let current = getCurrentEpochKey(albumId);
  if (current) {
    log.debug('Got epoch key from cache', {
      albumId,
      epochId: current.epochId,
    });
    return current;
  }

  // Fetch and unwrap all epoch keys for album
  await fetchAndUnwrapEpochKeys(albumId);

  // Get current from cache
  current = getCurrentEpochKey(albumId);
  if (!current) {
    throw new EpochKeyError(
      `No epoch keys available for album ${albumId}`,
      EpochKeyErrorCode.NO_KEYS_AVAILABLE,
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
