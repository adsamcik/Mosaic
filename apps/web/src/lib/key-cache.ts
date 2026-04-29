/**
 * Secure Key Cache
 *
 * Caches the worker's opaque session-state blob in sessionStorage with
 * time-based expiration. The blob itself is encrypted with a random
 * in-memory AES key stored only in memory, preventing raw key
 * co-location with ciphertext.
 *
 * Slice 2 hard-cutover: the cache schema is now v2 — it stores the
 * worker's `serializeSessionState()` output (an opaque
 * `Uint8Array` containing only ciphertext / public material) plus the
 * salts the caller needs to call `restoreSessionState`. **Plaintext key
 * material never crosses the cache boundary.** v1 caches (which held
 * raw-bytes account/session/identity key material) are silently
 * invalidated on first read.
 *
 * Security properties:
 * - Cached blob is opaque worker output (no raw key bytes in TS land).
 * - Encrypted with AES-256-GCM under a memory-only key before storage.
 * - Encryption key exists only in memory (cleared on tab close/reload).
 * - Expiration timestamp prevents indefinite key persistence.
 * - Automatic cleanup on expiration.
 */

import { createLogger } from './logger';
import { toArrayBufferView } from './buffer-utils';
import { getKeyCacheDurationMs } from './settings-service';

const log = createLogger('KeyCache');

/** Storage key for cached keys */
const KEY_CACHE_STORAGE_KEY = 'mosaic:keyCache';

/**
 * Schema version for the cached blob. Bumped to `2` for the Slice 2 hard
 * cutover to the opaque session-state format. Reading a cached entry that
 * lacks `version: 2` returns `null` and clears the entry — old caches
 * holding raw bytes (v1) are intentionally invalidated.
 */
const CACHE_SCHEMA_VERSION = 2 as const;

/** In-memory encryption key for the cache (never persisted) */
let cacheEncryptionKey: CryptoKey | null = null;

/**
 * Cached session state.
 *
 * The opaque `sessionState` blob is the output of the crypto worker's
 * `serializeSessionState()` method — a versioned binary bundle that
 * contains only opaque ciphertext fields (wrapped account key, wrapped
 * identity seed) plus the auth public key. The TS layer NEVER decodes
 * the blob; it round-trips through `restoreSessionState`.
 */
export interface CachedKeys {
  /** Opaque session-state blob from the worker, base64-encoded. */
  sessionState: string;
  /** User salt - 16 bytes base64. Needed to re-run L1 KDF on restore. */
  userSalt: string;
  /** Account salt - 16 bytes base64. Needed to re-run L1 KDF on restore. */
  accountSalt: string;
  /** Cache schema version. Always `2` for the current format. */
  version: typeof CACHE_SCHEMA_VERSION;
}

/** Stored cache envelope */
interface CacheEnvelope {
  /** Encrypted keys (base64) */
  ciphertext: string;
  /** Encryption nonce (base64) */
  nonce: string;
  /** Expiration timestamp (ms since epoch, or 0 for no expiry) */
  expiresAt: number;
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
 * Get or create the in-memory encryption key.
 * The key is non-extractable and never persisted.
 */
async function getCacheEncryptionKey(): Promise<CryptoKey> {
  if (cacheEncryptionKey) {
    return cacheEncryptionKey;
  }

  // Generate a random AES-256 key
  cacheEncryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return cacheEncryptionKey;
}

/**
 * Check if key caching is enabled.
 */
export function isKeyCachingEnabled(): boolean {
  return getKeyCacheDurationMs() > 0;
}

/**
 * Cache the worker's session-state bundle securely in sessionStorage.
 * The opaque blob is encrypted with a memory-only AES-GCM key before
 * storage. v1 caches lacking `version: 2` are silently invalidated on
 * first read.
 *
 * @param keys - The v2 cached payload (opaque session state + salts).
 */
export async function cacheKeys(keys: CachedKeys): Promise<void> {
  const durationMs = getKeyCacheDurationMs();
  if (durationMs === 0) {
    log.debug('Key caching disabled, skipping cache');
    return;
  }

  if (keys.version !== CACHE_SCHEMA_VERSION) {
    log.error(
      `Refusing to cache keys with unexpected schema version ${String(keys.version)} (expected ${String(CACHE_SCHEMA_VERSION)})`,
    );
    return;
  }

  try {
    const encKey = await getCacheEncryptionKey();
    const plaintext = new TextEncoder().encode(JSON.stringify(keys));
    try {
      // Generate random nonce
      const nonce = crypto.getRandomValues(new Uint8Array(12));

      // Encrypt
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBufferView(nonce) },
        encKey,
        toArrayBufferView(plaintext),
      );

      // Calculate expiration (0 = no expiry for "until tab close")
      const expiresAt = durationMs === Infinity ? 0 : Date.now() + durationMs;

      const envelope: CacheEnvelope = {
        ciphertext: toBase64(new Uint8Array(ciphertext)),
        nonce: toBase64(nonce),
        expiresAt,
      };

      sessionStorage.setItem(KEY_CACHE_STORAGE_KEY, JSON.stringify(envelope));
      log.debug('Keys cached successfully, expires:', {
        expiresAt:
          expiresAt === 0 ? 'on tab close' : new Date(expiresAt).toISOString(),
      });
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    log.error('Failed to cache keys:', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Non-fatal - keys just won't be cached
  }
}

/**
 * Retrieve cached session-state bundle from sessionStorage.
 *
 * Returns `null` if cache is empty, expired, decryption fails, or the
 * stored blob is from an older schema (v1 caches are silently dropped).
 */
export async function getCachedKeys(): Promise<CachedKeys | null> {
  // Check if caching is enabled
  if (!isKeyCachingEnabled()) {
    return null;
  }

  try {
    const stored = sessionStorage.getItem(KEY_CACHE_STORAGE_KEY);
    if (!stored) {
      log.debug('No cached keys in sessionStorage');
      return null;
    }

    const envelope: CacheEnvelope = JSON.parse(stored);

    // Check expiration (0 means no expiry)
    if (envelope.expiresAt !== 0 && Date.now() > envelope.expiresAt) {
      log.debug('Cached keys expired');
      clearCachedKeys();
      return null;
    }

    if (!cacheEncryptionKey) {
      log.debug('No in-memory cache encryption key available');
      clearCachedKeys();
      return null;
    }

    // Get the in-memory encryption key
    const encKey = await getCacheEncryptionKey();

    // Decrypt
    const ciphertext = fromBase64(envelope.ciphertext);
    const nonce = fromBase64(envelope.nonce);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBufferView(nonce) },
      encKey,
      toArrayBufferView(ciphertext),
    );

    const plaintextBytes = new Uint8Array(plaintext);
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(plaintextBytes),
      ) as Partial<CachedKeys> & Record<string, unknown>;

      // Slice 2 cutover: invalidate v1 caches that lack the version
      // marker or are pinned to an older schema.
      if (parsed.version !== CACHE_SCHEMA_VERSION) {
        log.info(
          `Discarding cached keys from older schema (version=${String(parsed.version)}), please log in again`,
        );
        clearCachedKeys();
        return null;
      }

      if (
        typeof parsed.sessionState !== 'string' ||
        typeof parsed.userSalt !== 'string' ||
        typeof parsed.accountSalt !== 'string'
      ) {
        log.warn('Cached keys missing required v2 fields, discarding');
        clearCachedKeys();
        return null;
      }

      log.debug('Retrieved cached keys successfully');
      return {
        sessionState: parsed.sessionState,
        userSalt: parsed.userSalt,
        accountSalt: parsed.accountSalt,
        version: CACHE_SCHEMA_VERSION,
      };
    } finally {
      plaintextBytes.fill(0);
    }
  } catch (error) {
    log.error('Failed to retrieve cached keys:', error);
    clearCachedKeys();
    return null;
  }
}

/**
 * Clear cached keys from sessionStorage.
 */
export function clearCachedKeys(): void {
  sessionStorage.removeItem(KEY_CACHE_STORAGE_KEY);
  log.debug('Cleared cached keys');
}

/**
 * Clear the in-memory encryption key.
 * Called on logout to ensure keys cannot be recovered.
 */
export function clearCacheEncryptionKey(): void {
  cacheEncryptionKey = null;
  clearCachedKeys();
  log.debug('Cleared cache encryption key');
}

/**
 * Check if valid cached keys exist (without decrypting).
 * Used to determine if we can skip password entry.
 */
export function hasCachedKeys(): boolean {
  if (!cacheEncryptionKey) {
    return false;
  }

  try {
    const stored = sessionStorage.getItem(KEY_CACHE_STORAGE_KEY);
    if (!stored) {
      return false;
    }

    const envelope: CacheEnvelope = JSON.parse(stored);

    // Check expiration
    if (envelope.expiresAt !== 0 && Date.now() > envelope.expiresAt) {
      clearCachedKeys();
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
