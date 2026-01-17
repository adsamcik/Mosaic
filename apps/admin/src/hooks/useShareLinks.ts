/**
 * Share Links Hook
 *
 * Provides share link management for albums including:
 * - Fetching existing share links
 * - Creating new share links with tier key wrapping
 * - Revoking share links
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AccessTier,
  CreateShareLinkRequest,
  ShareLinkResponse,
  WrappedKeyRequest,
} from '../lib/api-types';
import { getApi, toBase64 } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import { fetchAndUnwrapEpochKeys } from '../lib/epoch-key-service';
import { getCachedEpochIds, getEpochKey } from '../lib/epoch-key-store';

/** Error thrown by share link operations */
export class ShareLinkError extends Error {
  constructor(
    message: string,
    public readonly code: ShareLinkErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

/** Share link error codes */
export enum ShareLinkErrorCode {
  /** Failed to fetch share links */
  FETCH_FAILED = 'FETCH_FAILED',
  /** Failed to create share link */
  CREATE_FAILED = 'CREATE_FAILED',
  /** Failed to revoke share link */
  REVOKE_FAILED = 'REVOKE_FAILED',
  /** No epoch keys available */
  NO_EPOCH_KEYS = 'NO_EPOCH_KEYS',
  /** Failed to wrap tier keys */
  WRAP_FAILED = 'WRAP_FAILED',
  /** Failed to derive link keys */
  DERIVE_FAILED = 'DERIVE_FAILED',
}

/** Share link with display information */
export interface ShareLinkInfo extends ShareLinkResponse {
  /** Formatted expiry date */
  expiryDisplay?: string;
  /** Whether the link has expired */
  isExpired: boolean;
  /** Access tier display name */
  accessTierDisplay: string;
}

/** Options for creating a share link */
export interface CreateShareLinkOptions {
  /** Access tier (1=thumb, 2=preview, 3=full) */
  accessTier: AccessTier;
  /** Optional expiry date */
  expiresAt?: Date;
  /** Optional max uses limit */
  maxUses?: number;
}

/** Result of creating a share link */
export interface CreateShareLinkResult {
  /** The created share link */
  shareLink: ShareLinkInfo;
  /** The shareable URL with secret in fragment */
  shareUrl: string;
  /** The link secret (for copying) */
  linkSecret: string;
}

/** Hook return type */
export interface UseShareLinksResult {
  /** List of share links */
  shareLinks: ShareLinkInfo[];
  /** Whether links are loading */
  isLoading: boolean;
  /** Error during fetch */
  error: Error | null;
  /** Refresh share links list */
  refetch: () => Promise<void>;
  /** Create a new share link */
  createShareLink: (
    options: CreateShareLinkOptions,
  ) => Promise<CreateShareLinkResult>;
  /** Whether create is in progress */
  isCreating: boolean;
  /** Error during create */
  createError: string | null;
  /** Revoke a share link */
  revokeShareLink: (linkId: string) => Promise<void>;
  /** Whether revoke is in progress */
  isRevoking: boolean;
  /** Error during revoke */
  revokeError: string | null;
  /** Update share link expiration */
  updateExpiration: (
    linkId: string,
    expiresAt: Date | null,
    maxUses: number | null,
  ) => Promise<void>;
  /** Whether update is in progress */
  isUpdating: boolean;
  /** Error during update */
  updateError: string | null;
}

/**
 * Get display name for access tier
 */
function getAccessTierDisplay(tier: AccessTier): string {
  switch (tier) {
    case 1:
      return 'Thumbnails Only';
    case 2:
      return 'Preview';
    case 3:
      return 'Full Access';
    default:
      return 'Unknown';
  }
}

/**
 * Transform API response to ShareLinkInfo
 */
function toShareLinkInfo(link: ShareLinkResponse): ShareLinkInfo {
  const now = new Date();
  const expiresAt = link.expiresAt ? new Date(link.expiresAt) : undefined;
  const isExpired = expiresAt ? expiresAt < now : false;

  const expiryDisplay = expiresAt
    ? expiresAt.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : undefined;

  return {
    ...link,
    isExpired,
    accessTierDisplay: getAccessTierDisplay(link.accessTier),
    ...(expiryDisplay !== undefined && { expiryDisplay }),
  };
}

/**
 * Hook to manage share links for an album
 *
 * @param albumId - Album ID to manage share links for
 * @returns Share link management functions and state
 */
export function useShareLinks(albumId: string): UseShareLinksResult {
  const [shareLinks, setShareLinks] = useState<ShareLinkInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  /**
   * Fetch share links from API
   */
  const fetchShareLinks = useCallback(async () => {
    if (!albumId) return;

    try {
      setIsLoading(true);
      setError(null);

      const api = getApi();
      const links = await api.listShareLinks(albumId);

      // Transform to ShareLinkInfo and sort by creation date (newest first)
      const transformed = links
        .map(toShareLinkInfo)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

      setShareLinks(transformed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
    } finally {
      setIsLoading(false);
    }
  }, [albumId]);

  // Fetch on mount and when albumId changes
  useEffect(() => {
    fetchShareLinks();
  }, [fetchShareLinks]);

  /**
   * Create a new share link
   */
  const createShareLink = useCallback(
    async (options: CreateShareLinkOptions): Promise<CreateShareLinkResult> => {
      try {
        setIsCreating(true);
        setCreateError(null);

        // Import crypto functions dynamically
        const {
          generateLinkSecret,
          deriveLinkKeys,
          encodeLinkSecret,
          encodeLinkId,
          deriveTierKeys,
          wrapTierKeyForLink,
          AccessTier: AccessTierEnum,
        } = await import('@mosaic/crypto');

        const api = getApi();
        const crypto = await getCryptoClient();

        // Step 1: Ensure epoch keys are loaded
        await fetchAndUnwrapEpochKeys(albumId);
        const epochIds = getCachedEpochIds(albumId);

        if (epochIds.length === 0) {
          throw new ShareLinkError(
            'No epoch keys available for album',
            ShareLinkErrorCode.NO_EPOCH_KEYS,
          );
        }

        // Step 2: Generate link secret and derive keys
        const linkSecret = generateLinkSecret();
        const { linkId, wrappingKey } = deriveLinkKeys(linkSecret);

        // Step 3: Wrap the account key around the link secret for owner recovery
        const ownerEncryptedSecret =
          await crypto.wrapWithAccountKey(linkSecret);

        // Step 4: Wrap tier keys for each epoch
        const wrappedKeys: WrappedKeyRequest[] = [];

        for (const epochId of epochIds) {
          const epochBundle = getEpochKey(albumId, epochId);
          if (!epochBundle) continue;

          // Derive tier keys from epoch seed
          const tierKeys = deriveTierKeys(epochBundle.epochSeed);

          // Wrap keys based on access tier
          // Always wrap thumb key
          const wrappedThumb = wrapTierKeyForLink(
            tierKeys.thumbKey,
            AccessTierEnum.THUMB,
            wrappingKey,
          );
          wrappedKeys.push({
            epochId,
            tier: 1 as AccessTier,
            nonce: toBase64(wrappedThumb.nonce),
            encryptedKey: toBase64(wrappedThumb.encryptedKey),
          });

          // Wrap preview key if tier >= 2
          if (options.accessTier >= 2) {
            const wrappedPreview = wrapTierKeyForLink(
              tierKeys.previewKey,
              AccessTierEnum.PREVIEW,
              wrappingKey,
            );
            wrappedKeys.push({
              epochId,
              tier: 2 as AccessTier,
              nonce: toBase64(wrappedPreview.nonce),
              encryptedKey: toBase64(wrappedPreview.encryptedKey),
            });
          }

          // Wrap full key if tier >= 3
          if (options.accessTier >= 3) {
            const wrappedFull = wrapTierKeyForLink(
              tierKeys.fullKey,
              AccessTierEnum.FULL,
              wrappingKey,
            );
            wrappedKeys.push({
              epochId,
              tier: 3 as AccessTier,
              nonce: toBase64(wrappedFull.nonce),
              encryptedKey: toBase64(wrappedFull.encryptedKey),
            });
          }
        }

        // Step 5: Create the share link via API
        const request: CreateShareLinkRequest = {
          accessTier: options.accessTier,
          linkId: toBase64(linkId),
          ownerEncryptedSecret: toBase64(ownerEncryptedSecret),
          wrappedKeys,
        };

        if (options.expiresAt) {
          request.expiresAt = options.expiresAt.toISOString();
        }

        if (options.maxUses !== undefined) {
          request.maxUses = options.maxUses;
        }

        const response = await api.createShareLink(albumId, request);
        const shareLink = toShareLinkInfo(response);

        // Step 6: Build the shareable URL
        const baseUrl = window.location.origin;
        const encodedLinkId = encodeLinkId(linkId);
        const encodedSecret = encodeLinkSecret(linkSecret);
        const shareUrl = `${baseUrl}/s/${encodedLinkId}#k=${encodedSecret}`;

        // Add to list
        setShareLinks((prev) => [shareLink, ...prev]);

        return {
          shareLink,
          shareUrl,
          linkSecret: encodedSecret,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to create share link';
        setCreateError(message);
        throw err;
      } finally {
        setIsCreating(false);
      }
    },
    [albumId],
  );

  /**
   * Revoke a share link
   */
  const revokeShareLink = useCallback(async (linkId: string): Promise<void> => {
    try {
      setIsRevoking(true);
      setRevokeError(null);

      const api = getApi();
      await api.revokeShareLink(linkId);

      // Remove from list or mark as revoked
      setShareLinks((prev) =>
        prev.map((link) =>
          link.id === linkId ? { ...link, isRevoked: true } : link,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to revoke share link';
      setRevokeError(message);
      throw err;
    } finally {
      setIsRevoking(false);
    }
  }, []);

  /**
   * Update share link expiration
   */
  const updateExpiration = useCallback(
    async (
      linkId: string,
      expiresAt: Date | null,
      maxUses: number | null,
    ): Promise<void> => {
      try {
        setIsUpdating(true);
        setUpdateError(null);

        const api = getApi();
        const response = await api.updateShareLinkExpiration(albumId, linkId, {
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          maxUses,
        });

        // Update the link in the list
        const updatedLink = toShareLinkInfo(response);
        setShareLinks((prev) =>
          prev.map((link) => (link.id === linkId ? updatedLink : link)),
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update share link';
        setUpdateError(message);
        throw err;
      } finally {
        setIsUpdating(false);
      }
    },
    [albumId],
  );

  return {
    shareLinks,
    isLoading,
    error,
    refetch: fetchShareLinks,
    createShareLink,
    isCreating,
    createError,
    revokeShareLink,
    isRevoking,
    revokeError,
    updateExpiration,
    isUpdating,
    updateError,
  };
}
