/**
 * Link Keys Hook
 *
 * Manages share link key state including:
 * - Parsing link secret from URL fragment
 * - Deriving wrapping key from link secret
 * - Unwrapping tier keys from server response
 * - IndexedDB persistence for return visits
 */

import { useCallback, useEffect, useState } from 'react';
import type { AccessTier as AccessTierType } from '../lib/api-types';
import { createLogger } from '../lib/logger';

const log = createLogger('useLinkKeys');

/** Unwrapped tier key */
export interface TierKey {
  epochId: number;
  tier: AccessTierType;
  key: Uint8Array;
  /** Sign public key for manifest verification */
  signPubkey?: Uint8Array | undefined;
}

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
}

/** IndexedDB database name for link keys */
const DB_NAME = 'mosaic-link-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

/**
 * Open IndexedDB for link key storage
 */
async function openLinkKeysDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Store keyed by linkId, contains serialized tier keys
        db.createObjectStore(STORE_NAME, { keyPath: 'linkId' });
      }
    };
  });
}

/**
 * Serialize tier keys for IndexedDB storage
 */
interface StoredLinkKeys {
  linkId: string;
  albumId: string;
  accessTier: AccessTierType;
  keys: Array<{
    epochId: number;
    tier: AccessTierType;
    key: string; // Base64
    signPubkey?: string; // Base64
  }>;
  storedAt: number;
}

/**
 * Save tier keys to IndexedDB
 */
async function saveTierKeys(
  linkId: string,
  albumId: string,
  accessTier: AccessTierType,
  tierKeys: Map<number, Map<AccessTierType, TierKey>>
): Promise<void> {
  const db = await openLinkKeysDb();
  
  // Import toBase64 dynamically
  const { toBase64 } = await import('@mosaic/crypto');
  
  const keys: StoredLinkKeys['keys'] = [];
  for (const [epochId, tierMap] of tierKeys) {
    for (const [tier, tierKey] of tierMap) {
      const entry: StoredLinkKeys['keys'][number] = {
        epochId,
        tier,
        key: toBase64(tierKey.key),
      };
      if (tierKey.signPubkey) {
        entry.signPubkey = toBase64(tierKey.signPubkey);
      }
      keys.push(entry);
    }
  }

  const stored: StoredLinkKeys = {
    linkId,
    albumId,
    accessTier,
    keys,
    storedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(stored);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}

/**
 * Load tier keys from IndexedDB
 */
async function loadTierKeys(linkId: string): Promise<{
  albumId: string;
  accessTier: AccessTierType;
  tierKeys: Map<number, Map<AccessTierType, TierKey>>;
} | null> {
  const db = await openLinkKeysDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(linkId);

    request.onerror = () => {
      db.close();
      reject(request.error);
    };

    request.onsuccess = async () => {
      db.close();
      const stored = request.result as StoredLinkKeys | undefined;
      if (!stored) {
        resolve(null);
        return;
      }

      // Import fromBase64 dynamically
      const { fromBase64 } = await import('@mosaic/crypto');

      const tierKeys = new Map<number, Map<AccessTierType, TierKey>>();
      for (const key of stored.keys) {
        if (!tierKeys.has(key.epochId)) {
          tierKeys.set(key.epochId, new Map());
        }
        tierKeys.get(key.epochId)!.set(key.tier, {
          epochId: key.epochId,
          tier: key.tier,
          key: fromBase64(key.key),
          signPubkey: key.signPubkey ? fromBase64(key.signPubkey) : undefined,
        });
      }

      resolve({
        albumId: stored.albumId,
        accessTier: stored.accessTier,
        tierKeys,
      });
    };
  });
}

/**
 * Clear cached tier keys for a link
 */
export async function clearLinkKeys(linkId: string): Promise<void> {
  const db = await openLinkKeysDb();
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(linkId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}

/** Result of the useLinkKeys hook */
export interface UseLinkKeysResult extends LinkKeyState {
  /** Get the read key for an epoch (highest available tier) */
  getReadKey: (epochId: number) => Uint8Array | undefined;
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
  linkSecret: string | null
): UseLinkKeysResult {
  const [state, setState] = useState<LinkKeyState>({
    isLoading: true,
    error: null,
    linkId: null,
    accessTier: null,
    albumId: null,
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

    try {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      // Import crypto functions
      const {
        decodeLinkSecret,
        decodeLinkId,
        deriveLinkKeys,
        unwrapTierKeyFromLink,
        fromBase64,
        constantTimeEqual,
        AccessTier: AccessTierEnum,
      } = await import('@mosaic/crypto');

      // Decode and verify link secret/ID
      let secret: Uint8Array;
      let urlLinkId: Uint8Array;
      try {
        secret = decodeLinkSecret(linkSecret);
        urlLinkId = decodeLinkId(linkId);
      } catch {
        throw new Error('Invalid link format');
      }

      // Derive keys and verify linkId matches
      const { linkId: derivedLinkId, wrappingKey } = deriveLinkKeys(secret);
      if (!constantTimeEqual(urlLinkId, derivedLinkId)) {
        throw new Error('Link has been tampered with');
      }

      // Check IndexedDB cache first
      const cached = await loadTierKeys(linkId);
      if (cached) {
        setState({
          isLoading: false,
          error: null,
          linkId,
          accessTier: cached.accessTier,
          albumId: cached.albumId,
          tierKeys: cached.tierKeys,
          isValid: true,
        });
        return;
      }

      // Fetch link info from server
      const accessResponse = await fetch(`/api/s/${linkId}`);
      if (!accessResponse.ok) {
        const errorData = await accessResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Link access failed: ${accessResponse.status}`);
      }
      const linkAccess: LinkAccessResponse = await accessResponse.json();

      // Fetch wrapped keys from server
      const keysResponse = await fetch(`/api/s/${linkId}/keys`);
      if (!keysResponse.ok) {
        const errorData = await keysResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Key fetch failed: ${keysResponse.status}`);
      }
      const wrappedKeys: WrappedKeyResponse[] = await keysResponse.json();

      // Unwrap tier keys
      const tierKeys = new Map<number, Map<AccessTierType, TierKey>>();
      for (const wrapped of wrappedKeys) {
        try {
          const unwrapped = unwrapTierKeyFromLink(
            {
              tier: wrapped.tier as unknown as typeof AccessTierEnum.THUMB,
              nonce: fromBase64(wrapped.nonce),
              encryptedKey: fromBase64(wrapped.encryptedKey),
            },
            wrapped.tier as unknown as typeof AccessTierEnum.THUMB,
            wrappingKey
          );

          if (!tierKeys.has(wrapped.epochId)) {
            tierKeys.set(wrapped.epochId, new Map());
          }

          tierKeys.get(wrapped.epochId)!.set(wrapped.tier, {
            epochId: wrapped.epochId,
            tier: wrapped.tier,
            key: unwrapped,
            signPubkey: wrapped.signPubkey ? fromBase64(wrapped.signPubkey) : undefined,
          });
        } catch (err) {
          log.error(`Failed to unwrap key for epoch ${wrapped.epochId} tier ${wrapped.tier}`, err);
        }
      }

      // Save to IndexedDB for return visits
      await saveTierKeys(linkId, linkAccess.albumId, linkAccess.accessTier, tierKeys);

      setState({
        isLoading: false,
        error: null,
        linkId,
        accessTier: linkAccess.accessTier,
        albumId: linkAccess.albumId,
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
    (epochId: number): Uint8Array | undefined => {
      const epochTiers = state.tierKeys.get(epochId);
      if (!epochTiers) return undefined;

      // Return highest tier key available (3=full, 2=preview, 1=thumb)
      for (const tier of [3, 2, 1] as AccessTierType[]) {
        const tierKey = epochTiers.get(tier);
        if (tierKey) return tierKey.key;
      }
      return undefined;
    },
    [state.tierKeys]
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
    [state.tierKeys]
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
