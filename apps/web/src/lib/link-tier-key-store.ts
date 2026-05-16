/**
 * Link Tier Key Store
 *
 * Secure storage for share link tier keys in IndexedDB.
 * Keys are encrypted with a session-bound Rust wrap handle held only in
 * memory for the lifetime of the page.
 *
 * Security properties:
 * - Tier keys are encrypted before IndexedDB storage
 * - The encryption key is non-extractable: its raw bytes are never reachable
 *   from JavaScript (no exportKey, no sessionStorage persistence). Same-origin
 *   scripts therefore cannot read it via sessionStorage even with XSS.
 * - On full page reload (or new tab) the in-memory key is gone; existing
 *   IndexedDB entries become undecryptable and are treated as a cache miss
 *   so the link tier keys get refetched from the server.
 * - Automatic migration from legacy unencrypted format
 * - Defense-in-depth against IndexedDB access
 */

import { createLogger } from './logger';
import initRustWasm, {
  closeLinkTierWrapHandle,
  createLinkTierWrapHandle,
  unwrapLinkTierBlob,
  wrapLinkTierBlob,
} from '../generated/mosaic-wasm/mosaic_wasm.js';
import type { AccessTier as AccessTierType } from './api-types';
import { getCryptoClient } from './crypto-client';
import type { LinkTierHandleId } from '../workers/types';

const log = createLogger('LinkTierKeyStore');

/** Storage key for legacy persisted link encryption key (cleared on logout). */
const LINK_KEY_STORAGE_KEY = 'mosaic:linkKeyEncryption';

/** In-memory Rust wrap handle for link tier key storage */
let linkWrapHandle: bigint | null = null;
let rustWasmInitPromise: Promise<unknown> | null = null;

/** IndexedDB database name for link keys */
const DB_NAME = 'mosaic-link-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

/** Unwrapped tier key */
export interface TierKey {
  epochId: number;
  tier: AccessTierType;
  /** Legacy raw tier key, present only for pre-P-W7.6 cached entries. */
  key?: Uint8Array;
  /** Rust-owned link-tier handle used by production link decryption. */
  linkTierHandleId?: LinkTierHandleId;
  /** Sign public key for manifest verification */
  signPubkey?: Uint8Array | undefined;
}

/** Serialized tier key for storage */
interface SerializedTierKey {
  epochId: number;
  tier: AccessTierType;
  key?: string; // Legacy raw key, Base64
  linkTierHandleId?: LinkTierHandleId;
  signPubkey?: string; // Base64
}

/** Legacy (unencrypted) stored format */
interface LegacyStoredLinkKeys {
  linkId: string;
  albumId: string;
  accessTier: AccessTierType;
  keys: SerializedTierKey[];
  storedAt: number;
}

/** New encrypted stored format */
interface EncryptedStoredLinkKeys {
  linkId: string;
  version: 1;
  iv?: string; // Legacy WebCrypto Base64 IV; empty/missing for Rust-wrapped entries
  ciphertext: string; // Base64
  wrapVersion?: 2;
  storedAt: number;
}

/** Plaintext data that gets encrypted */
interface StoredLinkKeysPlaintext {
  albumId: string;
  accessTier: AccessTierType;
  keys: SerializedTierKey[];
}

/** Result from loading tier keys */
export interface LoadedTierKeys {
  albumId: string;
  accessTier: AccessTierType;
  tierKeys: Map<number, Map<AccessTierType, TierKey>>;
}

/**
 * Convert Uint8Array to base64 string.
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert base64 string to Uint8Array.
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deserializeLinkTierHandle(
  key: SerializedTierKey,
): Promise<LinkTierHandleId | undefined> {
  if (key.linkTierHandleId) {
    return key.linkTierHandleId;
  }
  if (!key.key) {
    return undefined;
  }

  const rawKey = fromBase64(key.key);
  try {
    const crypto = await getCryptoClient();
    return await crypto.mintLinkTierHandleFromRawKey(rawKey);
  } finally {
    rawKey.fill(0);
  }
}

async function ensureRustWasmInitialized(): Promise<void> {
  rustWasmInitPromise ??= initRustWasm();
  await rustWasmInitPromise;
}

function consumeBytesResult(
  result: { readonly code: number; readonly bytes: Uint8Array; free(): void },
  label: string,
): Uint8Array {
  try {
    if (result.code !== 0) {
      throw new Error(`${label} failed (rust code ${String(result.code)})`);
    }
    return new Uint8Array(result.bytes);
  } finally {
    result.free();
  }
}

async function getLinkWrapHandle(): Promise<bigint> {
  if (linkWrapHandle !== null) {
    return linkWrapHandle;
  }

  await ensureRustWasmInitialized();
  linkWrapHandle = createLinkTierWrapHandle();
  log.debug('Generated new Rust link tier wrap handle');
  return linkWrapHandle;
}

/**
 * Clear the in-memory encryption key.
 * Called on logout to ensure keys cannot be recovered.
 *
 * Also clears the legacy `LINK_KEY_STORAGE_KEY` sessionStorage entry so that
 * sessions upgraded from older builds do not leave the (now-unused) raw key
 * sitting in storage.
 */
export function clearLinkKeyEncryption(): void {
  if (linkWrapHandle !== null) {
    try {
      closeLinkTierWrapHandle(linkWrapHandle);
    } catch (error) {
      log.warn('Failed to close link tier wrap handle', { error });
    }
  }
  linkWrapHandle = null;
  sessionStorage.removeItem(LINK_KEY_STORAGE_KEY);
  log.debug('Cleared link key encryption');
}

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
        // Store keyed by linkId, contains encrypted tier keys
        db.createObjectStore(STORE_NAME, { keyPath: 'linkId' });
      }
    };
  });
}

/**
 * Save tier keys to IndexedDB with encryption
 */
export async function saveTierKeys(
  linkId: string,
  albumId: string,
  accessTier: AccessTierType,
  tierKeys: Map<number, Map<AccessTierType, TierKey>>,
): Promise<void> {
  const db = await openLinkKeysDb();

  try {
    // Serialize keys
    const keys: SerializedTierKey[] = [];
    for (const [epochId, tierMap] of tierKeys) {
      for (const [tier, tierKey] of tierMap) {
        const entry: SerializedTierKey = {
          epochId,
          tier,
        };
        if (tierKey.linkTierHandleId) {
          entry.linkTierHandleId = tierKey.linkTierHandleId;
        } else if (tierKey.key) {
          const crypto = await getCryptoClient();
          entry.linkTierHandleId = await crypto.mintLinkTierHandleFromRawKey(tierKey.key);
          tierKey.key.fill(0);
        }
        if (tierKey.signPubkey) {
          entry.signPubkey = toBase64(tierKey.signPubkey);
        }
        keys.push(entry);
      }
    }

    const plaintext: StoredLinkKeysPlaintext = {
      albumId,
      accessTier,
      keys,
    };

    const handle = await getLinkWrapHandle();
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const ciphertext = consumeBytesResult(
      wrapLinkTierBlob(handle, plaintextBytes),
      'wrapLinkTierBlob',
    );
    plaintextBytes.fill(0);

    // Store encrypted envelope
    const stored: EncryptedStoredLinkKeys = {
      linkId,
      version: 1,
      iv: '',
      ciphertext: toBase64(ciphertext),
      wrapVersion: 2,
      storedAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(stored);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
      tx.oncomplete = () => db.close();
    });

    log.debug('Saved encrypted tier keys', { linkId, keyCount: keys.length });
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Load tier keys from IndexedDB with decryption
 */
export async function getTierKeys(
  linkId: string,
): Promise<LoadedTierKeys | null> {
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
      const stored = request.result as
        | EncryptedStoredLinkKeys
        | LegacyStoredLinkKeys
        | undefined;

      if (!stored) {
        resolve(null);
        return;
      }

      try {
        let plaintext: StoredLinkKeysPlaintext;

        // Detect encrypted vs legacy format
        if ('ciphertext' in stored && 'version' in stored) {
          // Encrypted format - decrypt. Legacy WebCrypto-wrapped entries
          // cannot be opened after this cutover because their non-extractable
          // JS key was memory-only; clear them as cache misses.
          if (stored.wrapVersion !== 2) {
            log.info('Discarding legacy WebCrypto-wrapped tier keys', { linkId });
            await removeTierKeys(linkId);
            resolve(null);
            return;
          }
          const handle = await getLinkWrapHandle();
          const ciphertext = fromBase64(stored.ciphertext);

          try {
            const decrypted = consumeBytesResult(
              unwrapLinkTierBlob(handle, ciphertext),
              'unwrapLinkTierBlob',
            );
            try {
              plaintext = JSON.parse(new TextDecoder().decode(decrypted));
            } finally {
              decrypted.fill(0);
            }
          } catch (decryptError) {
            // Decryption failed (likely different session key)
            log.warn('Failed to decrypt tier keys, clearing entry', {
              linkId,
              error:
                decryptError instanceof Error
                  ? decryptError.message
                  : String(decryptError),
            });
            await removeTierKeys(linkId);
            resolve(null);
            return;
          }
        } else {
          // Legacy unencrypted format - migrate by re-saving
          log.info('Migrating legacy unencrypted tier keys', { linkId });
          const legacy = stored as LegacyStoredLinkKeys;
          plaintext = {
            albumId: legacy.albumId,
            accessTier: legacy.accessTier,
            keys: legacy.keys,
          };

          // Build tier keys map for migration
          const tierKeys = new Map<number, Map<AccessTierType, TierKey>>();
          for (const key of plaintext.keys) {
            if (!tierKeys.has(key.epochId)) {
              tierKeys.set(key.epochId, new Map());
            }
            const linkTierHandleId = await deserializeLinkTierHandle(key);
            const tierKey: TierKey = {
              epochId: key.epochId,
              tier: key.tier,
            };
            if (linkTierHandleId) {
              tierKey.linkTierHandleId = linkTierHandleId;
            }
            if (key.signPubkey) {
              tierKey.signPubkey = fromBase64(key.signPubkey);
            }
            tierKeys.get(key.epochId)!.set(key.tier, tierKey);
          }

          // Re-save with encryption (fire and forget)
          saveTierKeys(linkId, plaintext.albumId, plaintext.accessTier, tierKeys)
            .then(() => log.debug('Migrated tier keys to encrypted format', { linkId }))
            .catch((err) => log.error('Failed to migrate tier keys', err));
        }

        // Build tier keys map
        const tierKeys = new Map<number, Map<AccessTierType, TierKey>>();
        for (const key of plaintext.keys) {
          if (!tierKeys.has(key.epochId)) {
            tierKeys.set(key.epochId, new Map());
          }
          const linkTierHandleId = await deserializeLinkTierHandle(key);
          const tierKey: TierKey = {
            epochId: key.epochId,
            tier: key.tier,
          };
          if (linkTierHandleId) {
            tierKey.linkTierHandleId = linkTierHandleId;
          }
          if (key.signPubkey) {
            tierKey.signPubkey = fromBase64(key.signPubkey);
          }
          tierKeys.get(key.epochId)!.set(key.tier, tierKey);
        }

        resolve({
          albumId: plaintext.albumId,
          accessTier: plaintext.accessTier,
          tierKeys,
        });
      } catch (error) {
        log.error('Failed to load tier keys', error);
        resolve(null);
      }
    };
  });
}

/**
 * Remove tier keys for a specific link
 */
export async function removeTierKeys(linkId: string): Promise<void> {
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

/**
 * Clear all link tier keys from IndexedDB
 */
export async function clearAllTierKeys(): Promise<void> {
  const db = await openLinkKeysDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    tx.oncomplete = () => db.close();
  });
}
