/**
 * Epoch Rotation Service
 *
 * Handles epoch key rotation after member removal.
 * Generates fresh keys and distributes to remaining members.
 * Also updates share link wrapped keys during rotation.
 *
 * SECURITY: New epoch keys MUST be completely fresh random bytes.
 * NEVER derive from previous epoch keys.
 */

import { fromBase64, getApi, paginateAll, toBase64 } from './api';
import type {
  AlbumMember,
  CreateEpochKeyRequest,
  RotateEpochRequest,
  ShareLinkKeyUpdateRequest,
  ShareLinkWithSecretResponse,
} from './api-types';
import { getCryptoClient } from './crypto-client';
import { getDbClient } from './db-client';
import { fetchAndUnwrapEpochKeys } from './epoch-key-service';
import {
  clearAlbumKeys,
  setEpochKey,
  type EpochKeyBundle,
} from './epoch-key-store';
import { createLogger } from './logger';

const log = createLogger('EpochRotationService');

/** Error thrown when epoch rotation fails */
export class EpochRotationError extends Error {
  constructor(
    message: string,
    public readonly code: EpochRotationErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'EpochRotationError';
  }
}

/** Epoch rotation error codes */
export enum EpochRotationErrorCode {
  /** Failed to get album info */
  ALBUM_FETCH_FAILED = 'ALBUM_FETCH_FAILED',
  /** Failed to get members list */
  MEMBERS_FETCH_FAILED = 'MEMBERS_FETCH_FAILED',
  /** Identity not derived */
  IDENTITY_NOT_DERIVED = 'IDENTITY_NOT_DERIVED',
  /** No members to distribute keys to */
  NO_RECIPIENTS = 'NO_RECIPIENTS',
  /** Failed to generate new epoch key */
  KEY_GENERATION_FAILED = 'KEY_GENERATION_FAILED',
  /** Failed to seal key bundle */
  SEAL_FAILED = 'SEAL_FAILED',
  /** Failed to call rotate API */
  ROTATE_FAILED = 'ROTATE_FAILED',
  /** Recipient has no identity pubkey */
  RECIPIENT_NO_PUBKEY = 'RECIPIENT_NO_PUBKEY',
  /** Failed to fetch share links */
  SHARE_LINKS_FETCH_FAILED = 'SHARE_LINKS_FETCH_FAILED',
  /** Failed to wrap keys for share link */
  SHARE_LINK_WRAP_FAILED = 'SHARE_LINK_WRAP_FAILED',
}

/** Result of epoch rotation */
export interface EpochRotationResult {
  /** New epoch ID */
  newEpochId: number;
  /** Number of members who received the new key */
  recipientCount: number;
  /** Number of share links updated with new epoch keys */
  shareLinkCount: number;
}

/** Progress callback for rotation steps */
export type RotationProgressCallback = (step: RotationStep) => void;

/** Rotation progress steps */
export enum RotationStep {
  /** Fetching album information */
  FETCHING_ALBUM = 'FETCHING_ALBUM',
  /** Generating new epoch key */
  GENERATING_KEY = 'GENERATING_KEY',
  /** Fetching remaining members */
  FETCHING_MEMBERS = 'FETCHING_MEMBERS',
  /** Sealing keys for members */
  SEALING_KEYS = 'SEALING_KEYS',
  /** Fetching share links */
  FETCHING_SHARE_LINKS = 'FETCHING_SHARE_LINKS',
  /** Wrapping keys for share links */
  WRAPPING_SHARE_LINK_KEYS = 'WRAPPING_SHARE_LINK_KEYS',
  /** Calling rotate API */
  CALLING_API = 'CALLING_API',
  /** Updating local cache */
  UPDATING_CACHE = 'UPDATING_CACHE',
  /** Rotation complete */
  COMPLETE = 'COMPLETE',
}

/**
 * Rotate the epoch key for an album.
 *
 * This function:
 * 1. Gets current epoch ID from album
 * 2. Generates completely fresh random epoch key (CRITICAL for security)
 * 3. Fetches remaining members list
 * 4. Seals new key bundle to each member's identity pubkey
 * 5. Fetches active share links and wraps tier keys for them
 * 6. Calls rotate API with member bundles and share link keys
 * 7. Clears old keys and caches new epoch key
 *
 * @param albumId - Album to rotate keys for
 * @param onProgress - Optional callback for progress updates
 * @returns New epoch ID, recipient count, and share link count
 * @throws EpochRotationError if rotation fails
 */
export async function rotateEpoch(
  albumId: string,
  onProgress?: RotationProgressCallback,
): Promise<EpochRotationResult> {
  const api = getApi();
  const crypto = await getCryptoClient();

  // Step 1: Get album to determine current epoch ID
  onProgress?.(RotationStep.FETCHING_ALBUM);
  let currentEpochId: number;
  try {
    const album = await api.getAlbum(albumId);
    currentEpochId = album.currentEpochId;
  } catch (err) {
    throw new EpochRotationError(
      'Failed to get album information',
      EpochRotationErrorCode.ALBUM_FETCH_FAILED,
      err instanceof Error ? err : undefined,
    );
  }

  // Step 2: Generate fresh epoch key
  // SECURITY: This MUST be completely random, never derived from previous keys.
  // Slice 3 — minted as a Rust-owned epoch handle. The seed/sign-secret stay
  // in the worker; we only get back the opaque handle id, the wrapped seed
  // (publishable / persistable), and the per-epoch sign public key.
  onProgress?.(RotationStep.GENERATING_KEY);
  const newEpochId = currentEpochId + 1;
  let newEpochKey: {
    epochHandleId: string;
    wrappedSeed: Uint8Array;
    signPublicKey: Uint8Array;
  };
  try {
    newEpochKey = await crypto.generateEpochKey(newEpochId);
  } catch (err) {
    throw new EpochRotationError(
      'Failed to generate new epoch key',
      EpochRotationErrorCode.KEY_GENERATION_FAILED,
      err instanceof Error ? err : undefined,
    );
  }

  // Step 3: Get remaining members
  onProgress?.(RotationStep.FETCHING_MEMBERS);
  let members: AlbumMember[];
  try {
    members = await paginateAll((skip, take) =>
      api.listAlbumMembers(albumId, skip, take),
    );
  } catch (err) {
    throw new EpochRotationError(
      'Failed to fetch remaining members',
      EpochRotationErrorCode.MEMBERS_FETCH_FAILED,
      err instanceof Error ? err : undefined,
    );
  }

  if (members.length === 0) {
    throw new EpochRotationError(
      'No members to distribute keys to',
      EpochRotationErrorCode.NO_RECIPIENTS,
    );
  }

  // Step 4: Ensure identity is derived
  const identityPubkey = await crypto.getIdentityPublicKey();
  if (!identityPubkey) {
    try {
      await crypto.deriveIdentity();
    } catch (err) {
      throw new EpochRotationError(
        'Identity not derived - please log in again',
        EpochRotationErrorCode.IDENTITY_NOT_DERIVED,
        err instanceof Error ? err : undefined,
      );
    }
  }
  const signerPubkey = await crypto.getIdentityPublicKey();
  if (!signerPubkey) {
    throw new EpochRotationError(
      'Identity not derived - please log in again',
      EpochRotationErrorCode.IDENTITY_NOT_DERIVED,
    );
  }

  // Step 5: Seal key bundle to each member
  onProgress?.(RotationStep.SEALING_KEYS);
  const epochKeys: CreateEpochKeyRequest[] = [];

  for (const member of members) {
    const recipientPubkey = member.user?.identityPubkey;
    if (!recipientPubkey) {
      throw new EpochRotationError(
        `Member ${member.userId} has no identity public key`,
        EpochRotationErrorCode.RECIPIENT_NO_PUBKEY,
      );
    }

    try {
      const recipientPubkeyBytes = fromBase64(recipientPubkey);

      // Slice 3 — bundle payload bytes never cross Comlink. The worker
      // resolves the epoch handle internally and seals + signs in Rust.
      const sealed = await crypto.createEpochKeyBundle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        newEpochKey.epochHandleId as any,
        albumId,
        recipientPubkeyBytes,
      );

      epochKeys.push({
        recipientId: member.userId,
        epochId: newEpochId,
        encryptedKeyBundle: toBase64(sealed.encryptedBundle),
        ownerSignature: toBase64(sealed.signature),
        sharerPubkey: toBase64(signerPubkey),
        signPubkey: toBase64(newEpochKey.signPublicKey),
      });
    } catch (err) {
      throw new EpochRotationError(
        `Failed to seal key bundle for member ${member.userId}`,
        EpochRotationErrorCode.SEAL_FAILED,
        err instanceof Error ? err : undefined,
      );
    }
  }

  // Step 6: Fetch active share links and wrap tier keys for new epoch
  onProgress?.(RotationStep.FETCHING_SHARE_LINKS);
  let shareLinks: ShareLinkWithSecretResponse[] = [];
  try {
    shareLinks = await paginateAll((skip, take) =>
      api.listShareLinksWithSecrets(albumId, skip, take),
    );
  } catch (err) {
    throw new EpochRotationError(
      'Failed to fetch share links',
      EpochRotationErrorCode.SHARE_LINKS_FETCH_FAILED,
      err instanceof Error ? err : undefined,
    );
  }

  // Step 7: Wrap tier keys for each active share link
  onProgress?.(RotationStep.WRAPPING_SHARE_LINK_KEYS);
  const shareLinkKeys = await wrapKeysForShareLinks(
    shareLinks,
    newEpochKey.epochHandleId,
  );

  // Step 8: Call rotate API with member keys and share link keys
  onProgress?.(RotationStep.CALLING_API);
  try {
    const rotateRequest: RotateEpochRequest = { epochKeys };
    if (shareLinkKeys.length > 0) {
      rotateRequest.shareLinkKeys = shareLinkKeys;
    }
    await api.rotateEpoch(albumId, newEpochId, rotateRequest);
  } catch (err) {
    throw new EpochRotationError(
      'Failed to rotate epoch on server',
      EpochRotationErrorCode.ROTATE_FAILED,
      err instanceof Error ? err : undefined,
    );
  }

  // Step 9: Update local cache
  onProgress?.(RotationStep.UPDATING_CACHE);

  // Clear old epoch keys from store (closes their underlying Rust handles)
  clearAlbumKeys(albumId);

  // Cache the new epoch key reference for the current user.
  const newBundle: EpochKeyBundle = {
    epochId: newEpochId,
    epochHandleId: newEpochKey.epochHandleId,
    signPublicKey: newEpochKey.signPublicKey,
    // Slice 3 transitional placeholders — see EpochKeyBundle docs.
    epochSeed: new Uint8Array(0),
    signKeypair: {
      publicKey: newEpochKey.signPublicKey,
      secretKey: new Uint8Array(0),
    },
  };
  setEpochKey(albumId, newBundle);

  onProgress?.(RotationStep.COMPLETE);

  return {
    newEpochId,
    recipientCount: epochKeys.length,
    shareLinkCount: shareLinkKeys.length,
  };
}

/**
 * Wrap tier keys for all active share links during epoch rotation.
 *
 * For each share link with a stored owner-encrypted secret:
 * 1. Decrypt the owner-encrypted secret to get the link secret.
 * 2. Derive the per-link wrapping key from the link secret (in Rust).
 * 3. Wrap each tier key (up to the link's access tier) with the wrapping
 *    key using the new epoch handle (tier keys never leave the worker).
 *
 * Slice 3 — `epochHandleId` replaces the raw seed parameter so tier-key
 * derivation happens entirely inside the worker. Slice 6 will retire the
 * remaining `@mosaic/crypto` import here once `useShareLinks` /
 * `useLinkKeys` migrate.
 *
 * @param shareLinks - Active share links with owner-encrypted secrets.
 * @param epochHandleId - Rust-owned epoch handle for the new epoch.
 * @returns Share-link key updates ready for the rotate API request.
 */
// Exported for unit testing in __tests__/epoch-rotation-service.test.ts.
export async function wrapKeysForShareLinks(
  shareLinks: ShareLinkWithSecretResponse[],
  epochHandleId: string,
): Promise<ShareLinkKeyUpdateRequest[]> {
  // Import the @mosaic/crypto helpers that the worker hasn't yet absorbed
  // (Slice 6 retires this import). `memzero` is needed for the per-link
  // sensitive material the worker still hands back as plain bytes; tier
  // key derivation now happens inside Rust via `wrapTierKeyForLinkRust`.
  const { deriveLinkKeys, AccessTier, memzero } = await import('@mosaic/crypto');

  const crypto = await getCryptoClient();
  const results: ShareLinkKeyUpdateRequest[] = [];

  for (const link of shareLinks) {
    if (!link.ownerEncryptedSecret || link.isRevoked) {
      continue;
    }

    let linkSecret: Uint8Array | undefined;
    let wrappingKey: Uint8Array | undefined;

    try {
      const encryptedSecret = fromBase64(link.ownerEncryptedSecret);
      linkSecret = await crypto.unwrapWithAccountKey(encryptedSecret);

      const linkKeys = deriveLinkKeys(linkSecret);
      wrappingKey = linkKeys.wrappingKey;

      const wrappedKeys: ShareLinkKeyUpdateRequest['wrappedKeys'] = [];

      // Always wrap thumb key (tier 1).
      const wrappedThumb = await crypto.wrapTierKeyForLinkRust(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        epochHandleId as any,
        0,
        wrappingKey,
      );
      wrappedKeys.push({
        tier: AccessTier.THUMB,
        nonce: toBase64(wrappedThumb.nonce),
        encryptedKey: toBase64(wrappedThumb.encryptedKey),
      });

      if (link.accessTier >= 2) {
        const wrappedPreview = await crypto.wrapTierKeyForLinkRust(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          epochHandleId as any,
          1,
          wrappingKey,
        );
        wrappedKeys.push({
          tier: AccessTier.PREVIEW,
          nonce: toBase64(wrappedPreview.nonce),
          encryptedKey: toBase64(wrappedPreview.encryptedKey),
        });
      }

      if (link.accessTier >= 3) {
        const wrappedFull = await crypto.wrapTierKeyForLinkRust(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          epochHandleId as any,
          2,
          wrappingKey,
        );
        wrappedKeys.push({
          tier: AccessTier.FULL,
          nonce: toBase64(wrappedFull.nonce),
          encryptedKey: toBase64(wrappedFull.encryptedKey),
        });
      }

      results.push({
        shareLinkId: link.id,
        wrappedKeys,
      });
    } catch (err) {
      log.error(`Failed to wrap keys for share link ${link.id}:`, err);
      // Continue with other links — non-fatal at the rotation level.
    } finally {
      if (linkSecret) memzero(linkSecret);
      if (wrappingKey) memzero(wrappingKey);
    }
  }

  return results;
}

/**
 * Clear photo caches for an album after key rotation.
 *
 * This ensures old cached data (encrypted with old keys) is cleared.
 * New photos will be fetched and decrypted with new keys.
 *
 * @param albumId - Album to clear caches for
 */
export async function clearPhotoCaches(albumId: string): Promise<void> {
  // Clear epoch keys (already done in rotateEpoch, but safe to call again)
  clearAlbumKeys(albumId);

  // Clear cached photos from local database
  // This forces a full resync with fresh data encrypted under new keys
  try {
    const db = await getDbClient();
    await db.clearAlbumPhotos(albumId);
    log.debug('Cleared cached photos for album', { albumId });
  } catch (error) {
    log.warn('Failed to clear album photos cache', { albumId, error });
    // Non-fatal - sync engine will handle stale data gracefully
  }

  // Refresh epoch keys from server for current user
  try {
    await fetchAndUnwrapEpochKeys(albumId);
  } catch {
    // Ignore errors - will be fetched on next access
  }
}
