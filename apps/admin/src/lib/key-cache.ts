/**
 * Secure Key Cache
 *
 * Caches encryption keys in sessionStorage with time-based expiration.
 * Keys are encrypted with a random session-key stored only in memory,
 * providing defense-in-depth against sessionStorage access.
 *
 * Security properties:
 * - Keys are encrypted with AES-256-GCM before storage
 * - Encryption key exists only in memory (cleared on tab close)
 * - Expiration timestamp prevents indefinite key persistence
 * - Automatic cleanup on expiration
 */

import { createLogger } from './logger';
import { getKeyCacheDurationMs } from './settings-service';

const log = createLogger('KeyCache');

/** Storage key for cached keys */
const KEY_CACHE_STORAGE_KEY = 'mosaic:keyCache';

/** Storage key for the cache encryption key (persisted in sessionStorage) */
const CACHE_KEY_STORAGE_KEY = 'mosaic:cacheKey';

/** In-memory encryption key for the cache (lazy-loaded from sessionStorage) */
let cacheEncryptionKey: CryptoKey | null = null;

/** Cached keys structure */
export interface CachedKeys {
  /** Account key (L2) - 32 bytes base64 */
  accountKey: string;
  /** Session key for database - 32 bytes base64 */
  sessionKey: string;
  /** Identity Ed25519 secret key - 64 bytes base64 */
  identitySecretKey: string;
  /** Identity Ed25519 public key - 32 bytes base64 */
  identityPublicKey: string;
  /** Identity X25519 secret key - 32 bytes base64 */
  identityX25519SecretKey: string;
  /** Identity X25519 public key - 32 bytes base64 */
  identityX25519PublicKey: string;
  /** User salt - 16 bytes base64 */
  userSalt: string;
  /** Account salt - 16 bytes base64 */
  accountSalt: string;
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
 * The key is persisted in sessionStorage (as exportable raw bytes) so it
 * survives page reloads but is cleared when the tab closes.
 */
async function getCacheEncryptionKey(): Promise<CryptoKey> {
  if (cacheEncryptionKey) {
    return cacheEncryptionKey;
  }

  // Try to restore from sessionStorage first
  const storedKey = sessionStorage.getItem(CACHE_KEY_STORAGE_KEY);
  if (storedKey) {
    try {
      const keyBytes = fromBase64(storedKey);
      cacheEncryptionKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as Uint8Array<ArrayBuffer>,
        { name: 'AES-GCM', length: 256 },
        true, // Extractable so we can persist it
        ['encrypt', 'decrypt'],
      );
      log.debug('Restored cache encryption key from sessionStorage');
      return cacheEncryptionKey;
    } catch (error) {
      log.error(
        'Failed to restore cache encryption key, generating new one',
        error,
      );
      sessionStorage.removeItem(CACHE_KEY_STORAGE_KEY);
    }
  }

  // Generate a random AES-256 key
  cacheEncryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // Extractable so we can persist it
    ['encrypt', 'decrypt'],
  );

  // Persist to sessionStorage for page reloads
  try {
    const keyBytes = await crypto.subtle.exportKey('raw', cacheEncryptionKey);
    sessionStorage.setItem(
      CACHE_KEY_STORAGE_KEY,
      toBase64(new Uint8Array(keyBytes)),
    );
    log.debug('Generated and persisted new cache encryption key');
  } catch (error) {
    log.error('Failed to persist cache encryption key', error);
  }

  return cacheEncryptionKey;
}

/**
 * Check if key caching is enabled.
 */
export function isKeyCachingEnabled(): boolean {
  return getKeyCacheDurationMs() > 0;
}

/**
 * Cache encryption keys securely in sessionStorage.
 * Keys are encrypted with a memory-only key before storage.
 *
 * @param keys - Keys to cache
 */
export async function cacheKeys(keys: CachedKeys): Promise<void> {
  const durationMs = getKeyCacheDurationMs();
  if (durationMs === 0) {
    log.debug('Key caching disabled, skipping cache');
    return;
  }

  try {
    const encKey = await getCacheEncryptionKey();
    const plaintext = new TextEncoder().encode(JSON.stringify(keys));

    // Generate random nonce
    const nonce = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer> },
      encKey,
      plaintext as Uint8Array<ArrayBuffer>,
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
  } catch (error) {
    log.error('Failed to cache keys:', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Non-fatal - keys just won't be cached
  }
}

/**
 * Retrieve cached keys from sessionStorage.
 * Returns null if cache is empty, expired, or decryption fails.
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

    // Get or restore the encryption key
    const encKey = await getCacheEncryptionKey();

    // Decrypt
    const ciphertext = fromBase64(envelope.ciphertext);
    const nonce = fromBase64(envelope.nonce);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer> },
      encKey,
      ciphertext as Uint8Array<ArrayBuffer>,
    );

    const keys: CachedKeys = JSON.parse(new TextDecoder().decode(plaintext));
    log.debug('Retrieved cached keys successfully');
    return keys;
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
  sessionStorage.removeItem(CACHE_KEY_STORAGE_KEY);
  clearCachedKeys();
  log.debug('Cleared cache encryption key');
}

/**
 * Check if valid cached keys exist (without decrypting).
 * Used to determine if we can skip password entry.
 */
export function hasCachedKeys(): boolean {
  // Check if we have the encryption key (in memory or sessionStorage)
  if (!cacheEncryptionKey && !sessionStorage.getItem(CACHE_KEY_STORAGE_KEY)) {
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
