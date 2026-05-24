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

/**
 * User-facing error raised when the IndexedDB open request is rejected
 * with a `VersionError` — almost always caused by another tab on this
 * origin having opened the database with a newer schema. The caller should
 * surface a clear "close other tabs and reload" message rather than a
 * generic IDB failure.
 */
export class IDBVersionMismatchError extends Error {
  constructor(message = 'Link key store version conflict — close other tabs and reload') {
    super(message);
    this.name = 'IDBVersionMismatchError';
  }
}

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
 * Type guard: true iff the IDB record is in the post-cutover encrypted
 * envelope format (has both `ciphertext` and `version`). Records lacking
 * these markers are pre-cutover plaintext entries and MUST be purged on
 * sight — they have no user/session scoping and could otherwise be loaded
 * by a different session on a shared browser, bypassing logout and
 * revocation expectations (security-review-2026-05-24-01).
 */
function isEncryptedRecord(value: unknown): value is EncryptedStoredLinkKeys {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ciphertext === 'string' &&
    typeof v.version === 'number' &&
    v.wrapVersion === 2
  );
}

/**
 * Walk every record in the link-keys store and delete anything that is not
 * a properly-encrypted post-cutover envelope. Runs every time the database
 * is opened so legacy plaintext entries written by older builds (or by a
 * previous session on a shared browser) can never be read or migrated.
 */
function purgeNonEncryptedRecords(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, 'readwrite');
    } catch (error) {
      reject(error);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.openCursor();
    let purged = 0;
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        if (!isEncryptedRecord(cursor.value)) {
          cursor.delete();
          purged += 1;
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      if (purged > 0) {
        log.warn('Purged legacy/invalid link tier records on store open', {
          purged,
        });
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Purge transaction aborted'));
  });
}

/**
 * Open IndexedDB for link key storage. Every open also sweeps and removes
 * any record that is not a properly-encrypted envelope, so legacy
 * unencrypted records cannot survive across sessions on shared browsers.
 */
async function openLinkKeysDb(): Promise<IDBDatabase> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      const err = (event.target as IDBOpenDBRequest | null)?.error ?? request.error;
      if (err && err.name === 'VersionError') {
        log.warn('IndexedDB VersionError opening link key store', {
          dbName: DB_NAME,
          requestedVersion: DB_VERSION,
        });
        reject(new IDBVersionMismatchError());
        return;
      }
      reject(err ?? new Error('Failed to open link key store'));
    };
    request.onblocked = () => {
      log.warn('IndexedDB open blocked — another tab holds an older version', {
        dbName: DB_NAME,
      });
    };
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Store keyed by linkId, contains encrypted tier keys
        db.createObjectStore(STORE_NAME, { keyPath: 'linkId' });
      }
    };
  });

  try {
    await purgeNonEncryptedRecords(db);
  } catch (error) {
    log.warn('Failed to purge legacy link tier records on open', { error });
    // Continue — purge failure must not break the store, but the load path
    // also rejects legacy records as a defence-in-depth check.
  }
  return db;
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

        // Only accept post-cutover encrypted envelopes. The open-time purge
        // already removes legacy plaintext records, but defence-in-depth: if
        // any non-encrypted record survives (e.g. purge transaction aborted),
        // refuse to load it and delete it now. Legacy records are NEVER
        // migrated — they have no user/session scoping and could otherwise
        // leak across sessions on a shared browser
        // (security-review-2026-05-24-01).
        if (!isEncryptedRecord(stored)) {
          log.warn(
            'Refusing to load legacy unencrypted link tier record; deleting',
            { linkId },
          );
          await removeTierKeys(linkId);
          resolve(null);
          return;
        }

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
          // Decryption failed (likely different session key / shared browser
          // session boundary). Fail closed: drop the entry.
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
 * Eviction hook invoked when sync (or the link-revocation flow) reports
 * that a link has been revoked. Drops the cached tier keys for that link
 * so the `mosaic-link-keys` IDB cannot grow unbounded with handles for
 * links the server no longer honours.
 *
 * Implemented as a thin alias around `removeTierKeys` to keep call-sites
 * semantically clear ("evict a revoked link") and to give the eviction
 * surface a stable name independent of the underlying storage helper.
 */
export async function evictLink(linkId: string): Promise<void> {
  log.debug('Evicting link tier keys on revocation', { linkId });
  await removeTierKeys(linkId);
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

/**
 * Purge ALL link tier key state on logout / session boundary.
 *
 * Wipes the in-memory Rust wrap handle AND every IndexedDB record. Must be
 * called on every logout / session-expiry path so that a stale link tier
 * key (encrypted or otherwise) cannot survive into a different user session
 * on a shared browser (security-review-2026-05-24-01).
 *
 * Safe to call from a sync teardown path: returns a promise that callers
 * may either await or fire-and-forget.
 */
export async function purgeAllLinkTierKeys(): Promise<void> {
  clearLinkKeyEncryption();
  try {
    await clearAllTierKeys();
  } catch (error) {
    log.warn('Failed to clear link tier keys on logout', { error });
  }
}
