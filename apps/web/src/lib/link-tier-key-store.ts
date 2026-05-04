/**
 * Link Tier Key Store
 *
 * Secure storage for share link tier keys in IndexedDB.
 * Keys are encrypted with AES-256-GCM using a session-bound, non-extractable
 * encryption key held only in memory for the lifetime of the page.
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
import { toArrayBufferView } from './buffer-utils';
import type { AccessTier as AccessTierType } from './api-types';
import type { LinkTierHandleId } from '../workers/types';

const log = createLogger('LinkTierKeyStore');

/** Storage key for legacy persisted link encryption key (cleared on logout). */
const LINK_KEY_STORAGE_KEY = 'mosaic:linkKeyEncryption';

/** In-memory encryption key for link tier keys */
let linkEncryptionKey: CryptoKey | null = null;

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
  key: string; // Base64
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
  iv: string; // Base64
  ciphertext: string; // Base64
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

/**
 * Get or create the in-memory encryption key for link tier keys.
 *
 * The key is non-extractable and is intentionally NOT persisted to
 * sessionStorage: persisting the raw bytes would let any same-origin script
 * (XSS, malicious extension) decrypt the IndexedDB-stored wrapped link tier
 * keys. As a tradeoff, the key is lost on full page reload — existing
 * IndexedDB entries become undecryptable and `getTierKeys()` falls back to
 * "cache miss, refetch from server."
 */
async function getLinkEncryptionKey(): Promise<CryptoKey> {
  if (linkEncryptionKey) {
    return linkEncryptionKey;
  }

  linkEncryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  log.debug('Generated new non-extractable link encryption key');

  return linkEncryptionKey;
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
  linkEncryptionKey = null;
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
          key: tierKey.key ? toBase64(tierKey.key) : '',
        };
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

    // Encrypt with AES-GCM
    const encKey = await getLinkEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBufferView(iv) },
      encKey,
      toArrayBufferView(plaintextBytes),
    );

    // Store encrypted envelope
    const stored: EncryptedStoredLinkKeys = {
      linkId,
      version: 1,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
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
          // Encrypted format - decrypt
          const encKey = await getLinkEncryptionKey();
          const iv = fromBase64(stored.iv);
          const ciphertext = fromBase64(stored.ciphertext);

          try {
            const decrypted = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: toArrayBufferView(iv) },
              encKey,
              toArrayBufferView(ciphertext),
            );
            plaintext = JSON.parse(new TextDecoder().decode(decrypted));
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
            tierKeys.get(key.epochId)!.set(key.tier, {
              epochId: key.epochId,
              tier: key.tier,
              key: fromBase64(key.key),
              signPubkey: key.signPubkey ? fromBase64(key.signPubkey) : undefined,
            });
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
          tierKeys.get(key.epochId)!.set(key.tier, {
            epochId: key.epochId,
            tier: key.tier,
            key: fromBase64(key.key),
            signPubkey: key.signPubkey ? fromBase64(key.signPubkey) : undefined,
          });
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
