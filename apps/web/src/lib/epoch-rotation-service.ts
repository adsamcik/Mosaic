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
  // SECURITY: This MUST be completely random, never derived from previous keys
  onProgress?.(RotationStep.GENERATING_KEY);
  const newEpochId = currentEpochId + 1;
  let newEpochKey: {
    epochSeed: Uint8Array;
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
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
    // Get recipient's identity pubkey
    const recipientPubkey = member.user?.identityPubkey;
    if (!recipientPubkey) {
      throw new EpochRotationError(
        `Member ${member.userId} has no identity public key`,
        EpochRotationErrorCode.RECIPIENT_NO_PUBKEY,
      );
    }

    try {
      const recipientPubkeyBytes = fromBase64(recipientPubkey);

      const sealed = await crypto.createEpochKeyBundle(
        albumId,
        newEpochId,
        newEpochKey.epochSeed,
        newEpochKey.signPublicKey,
        newEpochKey.signSecretKey,
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
    newEpochKey.epochSeed,
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

  // Clear old epoch keys from store
  clearAlbumKeys(albumId);

  // Cache the new epoch key for current user
  const newBundle: EpochKeyBundle = {
    epochId: newEpochId,
    epochSeed: newEpochKey.epochSeed,
    signKeypair: {
      publicKey: newEpochKey.signPublicKey,
      secretKey: newEpochKey.signSecretKey,
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
 * 1. Decrypt the owner-encrypted secret to get the link secret
 * 2. Derive the wrapping key from the link secret
 * 3. Derive tier keys from the new epoch's seed
 * 4. Wrap each tier key (up to the link's access tier) with the wrapping key
 *
 * @param shareLinks - Active share links with owner-encrypted secrets
 * @param epochSeed - The new epoch's seed (32 bytes)
 * @returns Array of share link key updates for the rotation request
 */
async function wrapKeysForShareLinks(
  shareLinks: ShareLinkWithSecretResponse[],
  epochSeed: Uint8Array,
): Promise<ShareLinkKeyUpdateRequest[]> {
  // Import crypto functions dynamically to avoid circular deps
  const { deriveTierKeys, deriveLinkKeys, wrapTierKeyForLink, AccessTier } =
    await import('@mosaic/crypto');

  const crypto = await getCryptoClient();
  const results: ShareLinkKeyUpdateRequest[] = [];

  // Derive tier keys from the new epoch's seed
  const tierKeys = deriveTierKeys(epochSeed);

  for (const link of shareLinks) {
    // Skip links without owner-encrypted secrets
    if (!link.ownerEncryptedSecret || link.isRevoked) {
      continue;
    }

    try {
      // Decrypt the owner-encrypted secret to recover the link secret
      const encryptedSecret = fromBase64(link.ownerEncryptedSecret);
      const linkSecret = await crypto.unwrapWithAccountKey(encryptedSecret);

      // Derive the wrapping key from the link secret
      const { wrappingKey } = deriveLinkKeys(linkSecret);

      // Wrap tier keys up to the link's access tier
      const wrappedKeys: ShareLinkKeyUpdateRequest['wrappedKeys'] = [];

      // Always wrap thumb key (tier 1)
      const wrappedThumb = wrapTierKeyForLink(
        tierKeys.thumbKey,
        AccessTier.THUMB,
        wrappingKey,
      );
      wrappedKeys.push({
        tier: 1,
        nonce: toBase64(wrappedThumb.nonce),
        encryptedKey: toBase64(wrappedThumb.encryptedKey),
      });

      // Wrap preview key if access tier >= 2
      if (link.accessTier >= 2) {
        const wrappedPreview = wrapTierKeyForLink(
          tierKeys.previewKey,
          AccessTier.PREVIEW,
          wrappingKey,
        );
        wrappedKeys.push({
          tier: 2,
          nonce: toBase64(wrappedPreview.nonce),
          encryptedKey: toBase64(wrappedPreview.encryptedKey),
        });
      }

      // Wrap full key if access tier >= 3
      if (link.accessTier >= 3) {
        const wrappedFull = wrapTierKeyForLink(
          tierKeys.fullKey,
          AccessTier.FULL,
          wrappingKey,
        );
        wrappedKeys.push({
          tier: 3,
          nonce: toBase64(wrappedFull.nonce),
          encryptedKey: toBase64(wrappedFull.encryptedKey),
        });
      }

      results.push({
        shareLinkId: link.id,
        wrappedKeys,
      });
    } catch (err) {
      // Log but don't fail rotation for individual share link failures
      log.error(`Failed to wrap keys for share link ${link.id}:`, err);
      // Continue with other links
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
