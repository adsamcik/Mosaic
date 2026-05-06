/**
 * Link Keys Hook
 *
 * Manages share link key state including:
 * - Parsing link secret from URL fragment
 * - Deriving wrapping key from link secret
 * - Unwrapping tier keys from server response
 * - Encrypted IndexedDB persistence for return visits
 */

import { useCallback, useEffect, useState } from 'react';
import type { AccessTier as AccessTierType } from '../lib/api-types';
import { fromBase64 } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import {
  constantTimeEqual,
  decodeLinkId,
  decodeLinkSecret,
} from '../lib/link-encoding';
import {
  removeTierKeys as _removeTierKeys,
  type TierKey,
} from '../lib/link-tier-key-store';
import { createLogger } from '../lib/logger';
import type { LinkDecryptionKey } from '../workers/types';

const log = createLogger('useLinkKeys');

// Re-export TierKey for backward compatibility
export type { TierKey } from '../lib/link-tier-key-store';

/** Link key state */
export interface LinkKeyState {
  /** Whether keys are being loaded */
  isLoading: boolean;
  /** Error during key loading */
  error: Error | null;
  /** The link ID from URL */
  linkId: string | null;
  /** Access tier granted by this link */
  accessTier: AccessTierType | null;
  /** Album ID this link accesses */
  albumId: string | null;
  /** Encrypted album name (base64) */
  encryptedName: string | null;
  /** Short-lived grant token for limited-use share links */
  grantToken: string | null;
  /** Unwrapped tier keys by epoch */
  tierKeys: Map<number, Map<AccessTierType, TierKey>>;
  /** Whether the link is valid */
  isValid: boolean;
}

/** Wrapped key response from server */
export interface WrappedKeyResponse {
  epochId: number;
  tier: AccessTierType;
  nonce: string; // Base64
  encryptedKey: string; // Base64
  signPubkey?: string; // Base64
}

/** Link access response from server */
export interface LinkAccessResponse {
  albumId: string;
  accessTier: AccessTierType;
  epochCount: number;
  encryptedName?: string | null;
  grantToken?: string | null;
}

/**
 * Clear cached tier keys for a link (re-export for backward compatibility)
 */
export const clearLinkKeys = _removeTierKeys;

/** Result of the useLinkKeys hook */
export interface UseLinkKeysResult extends LinkKeyState {
  /** Get the read key for an epoch (highest available tier) */
  getReadKey: (epochId: number) => LinkDecryptionKey | undefined;
  /** Get the sign pubkey for an epoch */
  getSignPubkey: (epochId: number) => Uint8Array | undefined;
  /** Refresh keys from server */
  refresh: () => Promise<void>;
}

/**
 * Hook to manage share link keys
 *
 * @param linkId - The link ID from URL path (base64url encoded)
 * @param linkSecret - The link secret from URL fragment (base64url encoded)
 * @returns Link key state and utilities
 */
export function useLinkKeys(
  linkId: string | null,
  linkSecret: string | null,
): UseLinkKeysResult {
  const [state, setState] = useState<LinkKeyState>({
    isLoading: true,
    error: null,
    linkId: null,
    accessTier: null,
      albumId: null,
      encryptedName: null,
      grantToken: null,
      tierKeys: new Map(),
      isValid: false,
    });

  /**
   * Fetch and unwrap keys from server
   */
  const fetchKeys = useCallback(async () => {
    if (!linkId || !linkSecret) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: new Error('Missing link ID or secret'),
        isValid: false,
      }));
      return;
    }

    let secret: Uint8Array | null = null;

    try {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      const crypto = await getCryptoClient();

      // Decode and verify link secret/ID
      let urlLinkId: Uint8Array;
      try {
        secret = decodeLinkSecret(linkSecret);
        urlLinkId = decodeLinkId(linkId);
      } catch {
        throw new Error('Invalid link format');
      }


      // Always fetch link info first so limited-use links consume access and return
      // a fresh grant token for subsequent /keys, /photos, and /shards requests.
      const accessResponse = await fetch(`/api/s/${linkId}`);
      if (!accessResponse.ok) {
        const errorData = await accessResponse.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Link access failed: ${accessResponse.status}`,
        );
      }
      const linkAccess: LinkAccessResponse = await accessResponse.json();

      // P-W7.6: link-tier handles are Rust-owned and not reload-persistent,
      // so this flow imports handles from the server-wrapped keys each load.

      // Fetch wrapped keys from server
      const keysResponse = await fetch(
        `/api/s/${linkId}/keys`,
        linkAccess.grantToken
          ? {
              headers: {
                'X-Share-Grant': linkAccess.grantToken,
              },
            }
          : {},
      );
      if (!keysResponse.ok) {
        const errorData = await keysResponse.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Key fetch failed: ${keysResponse.status}`,
        );
      }
      const wrappedKeys: WrappedKeyResponse[] = await keysResponse.json();

      // Unwrap tier keys
      log.debug('Unwrapping tier keys', {
        keyCount: wrappedKeys.length,
        epochs: [...new Set(wrappedKeys.map((k) => k.epochId))],
        tiers: wrappedKeys.map((k) => ({ epoch: k.epochId, tier: k.tier })),
      });

      const tierKeys = new Map<number, Map<AccessTierType, TierKey>>();
      for (const wrapped of wrappedKeys) {
        try {
          const imported = await crypto.importLinkTierHandle(
            secret,
            fromBase64(wrapped.nonce),
            fromBase64(wrapped.encryptedKey),
            linkAccess.albumId,
            wrapped.tier,
          );
          if (!constantTimeEqual(urlLinkId, imported.linkId)) {
            throw new Error('Link has been tampered with');
          }

          if (!tierKeys.has(wrapped.epochId)) {
            tierKeys.set(wrapped.epochId, new Map());
          }

          tierKeys.get(wrapped.epochId)!.set(wrapped.tier, {
            epochId: wrapped.epochId,
            tier: wrapped.tier,
            linkTierHandleId: imported.linkTierHandleId,
            signPubkey: wrapped.signPubkey
              ? fromBase64(wrapped.signPubkey)
              : undefined,
          });

          log.debug('Imported link tier handle', {
            epochId: wrapped.epochId,
            tier: wrapped.tier,
          });
        } catch (err) {
          log.error(
            `Failed to unwrap key for epoch ${wrapped.epochId} tier ${wrapped.tier}`,
            err,
          );
        }
      }

      setState({
        isLoading: false,
        error: null,
        linkId,
        accessTier: linkAccess.accessTier,
        albumId: linkAccess.albumId,
        encryptedName: linkAccess.encryptedName ?? null,
        grantToken: linkAccess.grantToken ?? null,
        tierKeys,
        isValid: true,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err : new Error(String(err)),
        isValid: false,
      }));
    } finally {
      secret?.fill(0);
    }
  }, [linkId, linkSecret]);

  // Fetch keys on mount
  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  /**
   * Get the read key for an epoch (returns highest available tier key)
   * For share links, tier keys ARE read keys derived from the epoch read key
   */
  const getReadKey = useCallback(
    (epochId: number): LinkDecryptionKey | undefined => {
      const epochTiers = state.tierKeys.get(epochId);
      if (!epochTiers) return undefined;

      // Return highest tier key available (3=full, 2=preview, 1=thumb)
      for (const tier of [3, 2, 1] as AccessTierType[]) {
        const tierKey = epochTiers.get(tier);
        if (tierKey) return tierKey.linkTierHandleId;
      }
      return undefined;
    },
    [state.tierKeys],
  );

  /**
   * Get the sign pubkey for manifest verification
   */
  const getSignPubkey = useCallback(
    (epochId: number): Uint8Array | undefined => {
      const epochTiers = state.tierKeys.get(epochId);
      if (!epochTiers) return undefined;

      // Sign pubkey is the same for all tiers in an epoch
      for (const tierKey of epochTiers.values()) {
        if (tierKey.signPubkey) return tierKey.signPubkey;
      }
      return undefined;
    },
    [state.tierKeys],
  );

  return {
    ...state,
    getReadKey,
    getSignPubkey,
    refresh: fetchKeys,
  };
}

/**
 * Parse share link URL fragment to extract link secret
 * Fragment format: #k={base64url-encoded-secret}
 */
export function parseLinkFragment(fragment: string): string | null {
  if (!fragment.startsWith('#k=')) return null;
  const encoded = fragment.slice(3);
  if (!encoded) return null;
  // Validate it looks like base64url
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  return encoded;
}
