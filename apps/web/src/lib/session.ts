import sodium from 'libsodium-wrappers-sumo';
import { getArgon2Params } from '@mosaic/crypto';
import { toArrayBufferView } from './buffer-utils';
import { clearAllCovers } from './album-cover-service';
import { clearAllCachedMetadata } from './album-metadata-service';
import { fromBase64, getApi, toBase64 } from './api';
import { clearPlaceholderCache } from './thumbhash-decoder';
import { clearPhotoCache } from './photo-service';
import type { User } from './api-types';
import { closeCryptoClient, getCryptoClient } from './crypto-client';
import { closeDbClient, getDbClient } from './db-client';
import { clearAllEpochKeys } from './epoch-key-store';
import { closeGeoClient } from './geo-client';
import {
  cacheKeys,
  clearCacheEncryptionKey,
  getCachedKeys,
  hasCachedKeys,
  type CachedKeys,
} from './key-cache';
import { clearLinkKeyEncryption } from './link-tier-key-store';
import { localAuthLogin, localAuthRegister } from './local-auth';
import { createLogger } from './logger';
import { getIdleTimeoutMs, subscribeToSettings } from './settings-service';
import { syncCoordinator } from './sync-coordinator';

const log = createLogger('session');

/** Events that reset the idle timer */
const ACTIVITY_EVENTS = [
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
] as const;

/** Salt storage key in localStorage */
const USER_SALT_KEY = 'mosaic:userSalt';

/** Session state stored in sessionStorage for page reload detection */
const SESSION_STATE_KEY = 'mosaic:sessionState';

/**
 * Salt-encryption envelope format.
 *
 * On-wire layout for the `User.encryptedSalt` blob (after base64 decode):
 *
 *   v2: [0x02][AES-GCM ciphertext+tag]   (current; KDF = Argon2id)
 *   v1: [AES-GCM ciphertext+tag]         (legacy; KDF = PBKDF2-100k(username))
 *
 * The 12-byte AES-GCM nonce stays in `User.saltNonce` for both versions.
 *
 * Legacy v1 payloads are still decryptable so existing users can log in,
 * but every successful v1 decryption transparently re-encrypts the salt
 * as v2 and pushes it to the server. Migration is best-effort: if the
 * upload fails we log a warning and continue — the user is still logged
 * in, and the next login simply retries the upgrade.
 *
 * Argon2id's per-user salt is NOT stored on the server. Instead, it is
 * deterministically derived from a domain-separated BLAKE2b hash of the
 * username, so v2 introduces no new server-side fields.
 */
const SALT_ENCRYPTION_VERSION_V2 = 0x02;

/** Domain-separation prefix for the Argon2id salt to prevent cross-protocol reuse. */
const SALT_ENCRYPTION_DOMAIN_V2 = 'mosaic-salt-encryption-v2|';

/** Legacy PBKDF2 iteration count - retained for backward-compatible v1 decryption only. */
const LEGACY_SALT_ENCRYPTION_PBKDF2_ITERATIONS = 100000;

type SessionListener = () => void;

function legacyAccountSaltFromUserId(userId: string): Uint8Array {
  const userIdBytes = new TextEncoder().encode(userId).slice(0, 16);
  const accountSalt = new Uint8Array(16);
  accountSalt.set(userIdBytes);
  return accountSalt;
}

function resolveAccountSalt(user: User): Uint8Array {
  if (!user.accountSalt) {
    return legacyAccountSaltFromUserId(user.id);
  }

  const accountSalt = fromBase64(user.accountSalt);
  if (accountSalt.length !== 16) {
    throw new Error('Invalid account salt length');
  }

  return accountSalt;
}

/**
 * Error thrown when salt decryption fails (wrong password on new device)
 */
export class SaltDecryptionError extends Error {
  constructor(message: string = 'Failed to decrypt salt - incorrect password') {
    super(message);
    this.name = 'SaltDecryptionError';
  }
}

/**
 * Derive a 16-byte Argon2id salt from the username.
 *
 * Argon2id's memory cost makes targeted attacks on per-user salts uneconomic,
 * so deriving the salt deterministically from the username is acceptable.
 * The fixed Mosaic-specific domain-separation prefix prevents cross-protocol
 * reuse against any other system that might also use this username.
 *
 * Hash output is 16 bytes which matches `crypto_pwhash_SALTBYTES`.
 */
async function deriveArgon2SaltForUser(username: string): Promise<Uint8Array> {
  await sodium.ready;
  const input = new TextEncoder().encode(SALT_ENCRYPTION_DOMAIN_V2 + username);
  return sodium.crypto_generichash(16, input);
}

/**
 * Derive the v2 AES-GCM key from the password using Argon2id (libsodium).
 *
 * The 32-byte raw key from Argon2id is imported into Web Crypto as a
 * non-extractable AES-GCM key, then the raw buffer (and the password
 * buffer) are zeroed before this function returns.
 */
async function deriveSaltEncryptionKeyV2(
  password: string,
  username: string,
): Promise<CryptoKey> {
  await sodium.ready;
  const argon2Params = getArgon2Params();
  const argonSalt = await deriveArgon2SaltForUser(username);
  const passwordBytes = new TextEncoder().encode(password);

  let derived: Uint8Array | null = null;
  try {
    derived = sodium.crypto_pwhash(
      32,
      passwordBytes,
      argonSalt,
      argon2Params.iterations,
      argon2Params.memory * 1024, // KiB → bytes
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );

    // importKey copies the bytes internally; we can safely zero `derived` after.
    return await crypto.subtle.importKey(
      'raw',
      toArrayBufferView(derived),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    sodium.memzero(passwordBytes);
    if (derived) {
      sodium.memzero(derived);
    }
    sodium.memzero(argonSalt);
  }
}

/**
 * Derive the legacy v1 AES-GCM key (PBKDF2-100k with username as salt).
 *
 * Retained ONLY so existing users with v1 payloads can still log in. Any
 * successful v1 decryption immediately triggers a re-encryption with v2
 * via {@link migrateLegacySaltToV2}.
 */
async function deriveSaltEncryptionKeyV1Legacy(
  password: string,
  username: string,
): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  const usernameSalt = new TextEncoder().encode(username);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: usernameSalt,
      iterations: LEGACY_SALT_ENCRYPTION_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/** Build a v2 envelope (`0x02 || ciphertext+tag`) from a raw AES-GCM ciphertext. */
function encodeV2Envelope(ciphertext: Uint8Array): Uint8Array {
  const envelope = new Uint8Array(1 + ciphertext.length);
  envelope[0] = SALT_ENCRYPTION_VERSION_V2;
  envelope.set(ciphertext, 1);
  return envelope;
}

/**
 * Best-effort migration of a legacy v1 payload to v2.
 *
 * Called from {@link decryptSalt} after a successful v1 decryption. A failed
 * upload MUST NOT block login — we simply log a warning and let the next
 * login retry the upgrade.
 */
async function migrateLegacySaltToV2(
  salt: Uint8Array,
  password: string,
  username: string,
): Promise<void> {
  try {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      salt,
      password,
      username,
    );
    await getApi().updateCurrentUser({ encryptedSalt, saltNonce });
    log.info('Migrated salt encryption from PBKDF2 v1 to Argon2id v2');
  } catch (error) {
    log.warn(
      'Failed to migrate salt encryption to v2 - will retry on next login',
      { error },
    );
  }
}

/**
 * Encrypt the user salt with a password-derived key.
 *
 * Always emits the v2 envelope (Argon2id KDF, version-byte prefix).
 */
export async function encryptSalt(
  salt: Uint8Array,
  password: string,
  username: string,
): Promise<{ encryptedSalt: string; saltNonce: string }> {
  const key = await deriveSaltEncryptionKeyV2(password, username);

  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBufferView(nonce) },
    key,
    toArrayBufferView(salt),
  );

  const envelope = encodeV2Envelope(new Uint8Array(ciphertext));

  return {
    encryptedSalt: toBase64(envelope),
    saltNonce: toBase64(nonce),
  };
}

/**
 * Decrypt the user salt with a password-derived key.
 *
 * Tries v2 first (Argon2id, version byte `0x02`). On version-byte mismatch
 * or AES-GCM auth failure, falls back to the legacy v1 path (PBKDF2-100k).
 * A successful v1 decryption transparently re-encrypts the salt with v2
 * and uploads it to the server (best-effort; failures are logged but do
 * not block login).
 *
 * Throws {@link SaltDecryptionError} if both paths fail (wrong password,
 * tampered ciphertext, or unrecognised envelope).
 */
export async function decryptSalt(
  encryptedSaltBase64: string,
  saltNonceBase64: string,
  password: string,
  username: string,
): Promise<Uint8Array> {
  const envelope = fromBase64(encryptedSaltBase64);
  const nonce = fromBase64(saltNonceBase64);

  // --- Try v2 first ---
  if (envelope.length > 1 && envelope[0] === SALT_ENCRYPTION_VERSION_V2) {
    try {
      const key = await deriveSaltEncryptionKeyV2(password, username);
      const ciphertext = envelope.subarray(1);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBufferView(nonce) },
        key,
        toArrayBufferView(ciphertext),
      );
      return new Uint8Array(decrypted);
    } catch {
      // Fall through to v1 in case the version byte happens to coincide
      // with a legacy ciphertext's first byte (1-in-256 chance).
    }
  }

  // --- Try legacy v1 (PBKDF2-100k(username)) ---
  let salt: Uint8Array;
  try {
    const key = await deriveSaltEncryptionKeyV1Legacy(password, username);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBufferView(nonce) },
      key,
      toArrayBufferView(envelope),
    );
    salt = new Uint8Array(decrypted);
  } catch {
    throw new SaltDecryptionError();
  }

  // v1 succeeded — transparently upgrade the server-stored payload to v2.
  // This MUST NOT throw: a failed migration upload still allows login.
  await migrateLegacySaltToV2(salt, password, username);

  return salt;
}

/**
 * Session Manager
 * Handles user authentication state, worker initialization, and idle timeout
 */
class SessionManager {
  private idleTimer: number | null = null;
  private _isLoggedIn = false;
  private _currentUser: User | null = null;
  private listeners = new Set<SessionListener>();
  private boundResetIdleTimer: () => void;
  private settingsUnsubscribe: (() => void) | null = null;

  constructor() {
    this.boundResetIdleTimer = this.resetIdleTimer.bind(this);
  }

  /** Whether user is currently logged in */
  get isLoggedIn(): boolean {
    return this._isLoggedIn;
  }

  /** Current authenticated user */
  get currentUser(): User | null {
    return this._currentUser;
  }

  /**
   * Subscribe to session state changes
   * @returns Unsubscribe function
   */
  subscribe(callback: SessionListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  /**
   * Check if there's a valid session that can be restored.
   * Returns the user if session is valid, null if not authenticated.
   * This allows showing a "session restore" UI instead of full login.
   */
  async checkSession(): Promise<User | null> {
    try {
      const api = getApi();
      const user = await api.getCurrentUser();
      return user;
    } catch {
      // Session invalid or expired
      return null;
    }
  }

  /**
   * Check if session restoration is needed (has session state but not logged in)
   */
  get needsSessionRestore(): boolean {
    return (
      !this._isLoggedIn &&
      sessionStorage.getItem(SESSION_STATE_KEY) === 'active'
    );
  }

  /**
   * Clear corrupted or stuck session state without requiring authentication.
   * Use this when the user cannot restore their session (e.g., wrong password, corrupted data).
   * This clears all local session state but preserves encrypted data on the server.
   */
  async clearCorruptedSession(): Promise<void> {
    log.info('Clearing corrupted session state');

    // Clear idle timer
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Unsubscribe from settings changes and activity listeners
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }
    this.detachIdleListeners();

    // Clear cached data from memory before tearing down workers
    clearAllCachedMetadata();
    clearAllCovers();
    clearPlaceholderCache();
    clearPhotoCache();
    clearAllEpochKeys();
    clearCacheEncryptionKey();
    clearLinkKeyEncryption();

    // Dispose sync-related timers before closing worker clients
    syncCoordinator.dispose();

    // Tear down workers so worker-resident keys are dropped immediately
    const workerResults = await Promise.allSettled([
      closeDbClient(),
      closeCryptoClient(),
      Promise.resolve().then(() => closeGeoClient()),
    ]);

    workerResults.forEach((result, index) => {
      if (result.status !== 'rejected') {
        return;
      }

      const workerName =
        index === 0 ? 'db' : index === 1 ? 'crypto' : 'geo';
      log.warn(`Failed to close ${workerName} worker during session clear`, {
        error: result.reason,
      });
    });

    // Clear session storage (removes session state key and cached keys)
    sessionStorage.clear();

    // Reset internal state
    this._currentUser = null;
    this._isLoggedIn = false;

    // Notify listeners so UI updates
    this.notify();

    log.info('Session state cleared - user can now start fresh');
  }

  /**
   * Check if we can restore session from cached keys (no password needed).
   */
  get canRestoreFromCache(): boolean {
    return this.needsSessionRestore && hasCachedKeys();
  }

  /**
   * Restore session from cached keys (no password required).
   * Returns true if successful, false if cache is unavailable or expired.
   */
  async restoreFromCache(): Promise<boolean> {
    const cachedKeys = await getCachedKeys();
    if (!cachedKeys) {
      log.debug('No cached keys available for restore');
      return false;
    }

    try {
      // Request persistent storage for OPFS
      if (navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        if (!granted) {
          log.warn('Persistent storage not granted - data may be evicted');
        }
      }

      // Get current user from backend (authenticated via session cookie)
      const api = getApi();
      this._currentUser = await api.getCurrentUser();

      // Import cached keys into crypto worker
      const cryptoClient = await getCryptoClient();
      await cryptoClient.importKeys({
        accountKey: cachedKeys.accountKey,
        sessionKey: cachedKeys.sessionKey,
        identitySecretKey: cachedKeys.identitySecretKey,
        identityPublicKey: cachedKeys.identityPublicKey,
        identityX25519SecretKey: cachedKeys.identityX25519SecretKey,
        identityX25519PublicKey: cachedKeys.identityX25519PublicKey,
      });

      // Initialize database worker with session key
      const db = await getDbClient();
      const sessionKey = await cryptoClient.getSessionKey();
      await db.init(sessionKey);

      this._isLoggedIn = true;
      this.markSessionActive();
      this.notify();

      // Re-cache keys to extend expiration
      const userSalt = fromBase64(cachedKeys.userSalt);
      const accountSalt = fromBase64(cachedKeys.accountSalt);
      await this.cacheSessionKeys(userSalt, accountSalt);

      // Subscribe to settings changes to update idle timeout
      this.settingsUnsubscribe = subscribeToSettings(() => {
        if (this._isLoggedIn) {
          this.resetIdleTimer();
        }
      });

      // Start idle timeout tracking
      this.resetIdleTimer();
      this.attachIdleListeners();

      log.info('Session restored from cache (no password required)');
      return true;
    } catch (error) {
      log.error('Failed to restore session from cache:', error);
      // Clear invalid cache
      clearCacheEncryptionKey();
      clearLinkKeyEncryption();
      return false;
    }
  }

  /**
   * Mark session state as active (called after successful login)
   */
  private markSessionActive(): void {
    sessionStorage.setItem(SESSION_STATE_KEY, 'active');
  }

  /**
   * Cache keys for session restoration after page reload.
   * Only caches if key caching is enabled in settings.
   */
  private async cacheSessionKeys(
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
  ): Promise<void> {
    try {
      const cryptoClient = await getCryptoClient();
      const exportedKeys = await cryptoClient.exportKeys();
      if (!exportedKeys) {
        log.warn('Failed to export keys for caching - worker not initialized');
        return;
      }

      const cachedKeys: CachedKeys = {
        ...exportedKeys,
        userSalt: toBase64(userSalt),
        accountSalt: toBase64(accountSalt),
      };

      await cacheKeys(cachedKeys);
    } catch (error) {
      log.error('Failed to cache session keys:', error);
      // Non-fatal - session will require password on reload
    }
  }

  /**
   * Restore an existing session with password.
   * Use this after page reload when the session cookie is still valid
   * but crypto workers need to be reinitialized.
   *
   * @param password - User's password to derive keys
   * @param user - Optional user object from checkSession() to skip refetch
   * @throws SaltDecryptionError if password is wrong
   */
  async restoreSession(password: string, user?: User): Promise<void> {
    // Request persistent storage for OPFS
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        log.warn('Persistent storage not granted - data may be evicted');
      }
    }

    // Get current user from backend (authenticated via session cookie)
    const api = getApi();
    this._currentUser = user ?? (await api.getCurrentUser());

    // Get user salt - server should have it if user logged in before
    let userSalt: Uint8Array;
    const username = this._currentUser.authSub;

    if (this._currentUser.encryptedSalt && this._currentUser.saltNonce) {
      // Server has salt - decrypt it with password
      // If decryption fails, password is wrong - throw error
      userSalt = await decryptSalt(
        this._currentUser.encryptedSalt,
        this._currentUser.saltNonce,
        password,
        username,
      );
      // Store locally for faster subsequent operations
      localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));
    } else {
      // Server has no salt - use local storage
      const storedSalt = localStorage.getItem(USER_SALT_KEY);
      if (!storedSalt) {
        throw new Error('No salt available - please log in again');
      }
      userSalt = fromBase64(storedSalt);
    }

    const accountSalt = resolveAccountSalt(this._currentUser);

    // Initialize crypto worker with password and salts
    // Use wrapped account key if available to preserve identity
    const cryptoClient = await getCryptoClient();
    if (this._currentUser.wrappedAccountKey) {
      const wrappedKey = fromBase64(this._currentUser.wrappedAccountKey);
      await cryptoClient.initWithWrappedKey(
        password,
        userSalt,
        accountSalt,
        wrappedKey,
      );
    } else {
      log.warn(
        'Session restore without wrapped account key - identity may differ!',
      );
      await cryptoClient.init(password, userSalt, accountSalt);
    }

    // Derive identity keypair for epoch key operations
    await cryptoClient.deriveIdentity();

    // Initialize database worker with session key
    const db = await getDbClient();
    const sessionKey = await cryptoClient.getSessionKey();
    await db.init(sessionKey);

    this._isLoggedIn = true;
    this.markSessionActive();
    this.notify();

    // Cache keys for automatic restore on next reload
    await this.cacheSessionKeys(userSalt, accountSalt);

    // Subscribe to settings changes to update idle timeout
    this.settingsUnsubscribe = subscribeToSettings(() => {
      if (this._isLoggedIn) {
        this.resetIdleTimer();
      }
    });

    // Start idle timeout tracking
    this.resetIdleTimer();
    this.attachIdleListeners();
  }

  /**
   * Log in with password
   * Initializes crypto and database workers.
   * Syncs user salt with server for multi-device support.
   * @throws SaltDecryptionError if server has salt but decryption fails (wrong password)
   */
  async login(password: string): Promise<void> {
    // Request persistent storage for OPFS
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        log.warn('Persistent storage not granted - data may be evicted');
      }
    }

    // Get current user from backend (authenticated via reverse proxy)
    const api = getApi();
    this._currentUser = await api.getCurrentUser();

    // Multi-device salt synchronization:
    // 1. Check if server has encrypted salt
    // 2. If yes: decrypt with password+username key, use for main key derivation
    // 3. If no: use local salt or generate new, encrypt and upload to server
    let userSalt: Uint8Array;
    const username = this._currentUser.authSub;

    if (this._currentUser.encryptedSalt && this._currentUser.saltNonce) {
      // Server has salt - decrypt it (new device or returning user)
      // If decryption fails, password is wrong - throw error
      userSalt = await decryptSalt(
        this._currentUser.encryptedSalt,
        this._currentUser.saltNonce,
        password,
        username,
      );
      // Store locally for faster subsequent logins
      localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));
    } else {
      // Server has no salt - use local or generate new
      const storedSalt = localStorage.getItem(USER_SALT_KEY);

      if (storedSalt) {
        userSalt = fromBase64(storedSalt);
      } else {
        // First login ever - generate a new salt
        userSalt = crypto.getRandomValues(new Uint8Array(16));
        localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));
      }

      // Encrypt and upload salt to server for multi-device sync
      const { encryptedSalt, saltNonce } = await encryptSalt(
        userSalt,
        password,
        username,
      );
      await api.updateCurrentUser({ encryptedSalt, saltNonce });
    }

    const accountSalt = resolveAccountSalt(this._currentUser);

    // Initialize crypto worker with password and salts
    // Use wrapped account key if available to preserve identity
    const cryptoClient = await getCryptoClient();
    if (this._currentUser.wrappedAccountKey) {
      const wrappedKey = fromBase64(this._currentUser.wrappedAccountKey);
      await cryptoClient.initWithWrappedKey(
        password,
        userSalt,
        accountSalt,
        wrappedKey,
      );
    } else {
      // First login - generate new key and store it
      await cryptoClient.init(password, userSalt, accountSalt);

      // Derive identity to get public key
      await cryptoClient.deriveIdentity();

      // Save wrapped key and identity pubkey to server for future logins
      const wrappedAccountKey = await cryptoClient.getWrappedAccountKey();
      const identityPubkey = await cryptoClient.getIdentityPublicKey();
      if (wrappedAccountKey && identityPubkey) {
        const api = getApi();
        await api.updateCurrentUser({
          identityPubkey: toBase64(identityPubkey),
        });
        // Store wrapped key via a new API call or extend updateCurrentUser
        // For now, we'll update the user record with the wrapped key
        await fetch('/api/users/me/wrapped-key', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            wrappedAccountKey: toBase64(wrappedAccountKey),
          }),
        });
      }
    }

    // Derive identity keypair for epoch key operations
    // This is needed to open sealed epoch key bundles
    await cryptoClient.deriveIdentity();

    // Initialize database worker with session key
    const db = await getDbClient();
    const sessionKey = await cryptoClient.getSessionKey();
    await db.init(sessionKey);

    this._isLoggedIn = true;
    this.markSessionActive();
    this.notify();

    // Cache keys for automatic restore on next reload
    await this.cacheSessionKeys(userSalt, accountSalt);

    // Subscribe to settings changes to update idle timeout
    this.settingsUnsubscribe = subscribeToSettings(() => {
      if (this._isLoggedIn) {
        this.resetIdleTimer();
      }
    });

    // Start idle timeout tracking
    this.resetIdleTimer();
    this.attachIdleListeners();
  }

  /**
   * LocalAuth login with Ed25519 challenge-response.
   * Registers user if they don't exist.
   * Use this for local authentication mode.
   *
   * @param username - The username to login as
   * @param password - User's password for key derivation and authentication
   */
  async localLogin(username: string, password: string): Promise<void> {
    // Request persistent storage for OPFS
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        log.warn('Persistent storage not granted - data may be evicted');
      }
    }

    // Perform LocalAuth login (registers if user doesn't exist)
    const { userId, userSalt, accountSalt, isNewUser, wrappedAccountKey } =
      await localAuthLogin(username, password);

    // Now fetch the current user (we have a session cookie)
    const api = getApi();
    this._currentUser = await api.getCurrentUser();

    // Store salt locally
    localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));

    // Re-init crypto with the correct keys
    // For returning users, we MUST use the wrapped account key to get the same identity
    // that was used when the epoch keys were sealed
    const cryptoClient = await getCryptoClient();
    if (wrappedAccountKey) {
      // Returning user: unwrap their existing account key
      await cryptoClient.initWithWrappedKey(
        password,
        userSalt,
        accountSalt,
        wrappedAccountKey,
      );
    } else if (!isNewUser) {
      // Returning user but no wrapped key on server - this is a problem!
      // Fall back to generating new key (will break epoch key decryption)
      log.warn(
        'Returning user without wrapped account key - identity will differ!',
      );
      await cryptoClient.init(password, userSalt, accountSalt);
    }
    // For new users, localAuthLogin already called init() with correct key
    await cryptoClient.deriveIdentity();

    // Initialize database worker with session key
    const db = await getDbClient();
    const sessionKey = await cryptoClient.getSessionKey();
    await db.init(sessionKey);

    this._isLoggedIn = true;
    this.markSessionActive();
    this.notify();

    // Cache keys for automatic restore on next reload
    await this.cacheSessionKeys(userSalt, accountSalt);

    // Subscribe to settings changes
    this.settingsUnsubscribe = subscribeToSettings(() => {
      if (this._isLoggedIn) {
        this.resetIdleTimer();
      }
    });

    // Start idle timeout tracking
    this.resetIdleTimer();
    this.attachIdleListeners();

    log.info(
      `LocalAuth login successful: ${username} (${userId})${isNewUser ? ' [new user]' : ''}`,
    );
  }

  /**
   * LocalAuth registration with Ed25519 challenge-response.
   * Explicitly registers a new user (does not auto-login existing users).
   * Use this when user explicitly chooses to create a new account.
   *
   * @param username - The username to register
   * @param password - User's password for key derivation and authentication
   * @throws Error if username already exists
   */
  async localRegister(username: string, password: string): Promise<void> {
    // Request persistent storage for OPFS
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        log.warn('Persistent storage not granted - data may be evicted');
      }
    }

    // Perform LocalAuth registration (will fail if user exists)
    const { userId, userSalt, accountSalt, wrappedAccountKey } =
      await localAuthRegister(username, password);

    // Now fetch the current user (we have a session cookie)
    const api = getApi();
    this._currentUser = await api.getCurrentUser();

    // Store salt locally
    localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));

    // For new users, localAuthRegister already called init() with correct key
    // Just need to derive identity for epoch key operations
    const cryptoClient = await getCryptoClient();

    // Re-init if wrapped key provided (shouldn't happen for new users, but handle it)
    if (wrappedAccountKey) {
      await cryptoClient.initWithWrappedKey(
        password,
        userSalt,
        accountSalt,
        wrappedAccountKey,
      );
    }
    await cryptoClient.deriveIdentity();

    // Initialize database worker with session key
    const db = await getDbClient();
    const sessionKey = await cryptoClient.getSessionKey();
    await db.init(sessionKey);

    this._isLoggedIn = true;
    this.markSessionActive();
    this.notify();

    // Cache keys for automatic restore on next reload
    await this.cacheSessionKeys(userSalt, accountSalt);

    // Subscribe to settings changes
    this.settingsUnsubscribe = subscribeToSettings(() => {
      if (this._isLoggedIn) {
        this.resetIdleTimer();
      }
    });

    // Start idle timeout tracking
    this.resetIdleTimer();
    this.attachIdleListeners();

    log.info(`LocalAuth registration successful: ${username} (${userId})`);
  }

  /**
   * Log out and clear all session data
   */
  async logout(): Promise<void> {
    // Call backend logout to revoke session and clear cookie
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Ignore errors - continue with client-side cleanup
    }

    // Clear idle timer
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Unsubscribe from settings changes
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }

    // Remove activity listeners
    this.detachIdleListeners();

    // Clear cached metadata from memory
    clearAllCachedMetadata();

    // Clear album cover cache
    clearAllCovers();

    // Clear placeholder hash cache (thumbhash/blurhash)
    clearPlaceholderCache();

    // Clear photo cache (revokes decrypted blob URLs)
    clearPhotoCache();

    // Dispose sync coordinator (clears pending syncs and timers)
    syncCoordinator.dispose();

    // Clear epoch keys from memory
    clearAllEpochKeys();

    // Clear key cache encryption key
    clearCacheEncryptionKey();
    clearLinkKeyEncryption();

    // Close all workers and clear keys
    await closeDbClient();
    await closeCryptoClient();
    closeGeoClient();

    // Clear session state
    this._currentUser = null;
    sessionStorage.clear();

    // Reset URL to root when logging out (clean slate)
    if (window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }

    this._isLoggedIn = false;
    this.notify();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = window.setTimeout(() => {
      log.info('Session idle timeout - logging out');
      void this.logout();
    }, getIdleTimeoutMs());
  }

  private attachIdleListeners(): void {
    ACTIVITY_EVENTS.forEach((event) => {
      document.addEventListener(event, this.boundResetIdleTimer, {
        passive: true,
      });
    });
  }

  private detachIdleListeners(): void {
    ACTIVITY_EVENTS.forEach((event) => {
      document.removeEventListener(event, this.boundResetIdleTimer);
    });
  }
}

/** Global session manager instance */
export const session = new SessionManager();
