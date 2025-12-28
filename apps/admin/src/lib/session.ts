import { clearAllCovers } from './album-cover-service';
import { clearAllCachedMetadata } from './album-metadata-service';
import { fromBase64, getApi, toBase64 } from './api';
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
import { localAuthLogin } from './local-auth';
import { createLogger } from './logger';
import { getIdleTimeoutMs, subscribeToSettings } from './settings-service';

const log = createLogger('session');

/** Events that reset the idle timer */
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;

/** Salt storage key in localStorage */
const USER_SALT_KEY = 'mosaic:userSalt';

/** Session state stored in sessionStorage for page reload detection */
const SESSION_STATE_KEY = 'mosaic:sessionState';

/** PBKDF2 iterations for salt encryption key derivation */
const SALT_ENCRYPTION_ITERATIONS = 100000;

type SessionListener = () => void;

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
 * Derive a key for encrypting/decrypting the user salt.
 * Uses PBKDF2 with username as salt (since we don't have the user salt yet).
 * This solves the chicken-egg problem: we need a key before we have the salt.
 */
async function deriveSaltEncryptionKey(
  password: string,
  username: string
): Promise<CryptoKey> {
  // Import password as a key
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Use username as the salt for PBKDF2
  const usernameSalt = new TextEncoder().encode(username);

  // Derive AES-GCM key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: usernameSalt,
      iterations: SALT_ENCRYPTION_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt the user salt with a password-derived key.
 * Returns the encrypted salt and nonce as base64 strings.
 */
export async function encryptSalt(
  salt: Uint8Array,
  password: string,
  username: string
): Promise<{ encryptedSalt: string; saltNonce: string }> {
  const key = await deriveSaltEncryptionKey(password, username);

  // Generate random nonce (12 bytes for AES-GCM)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt the salt
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer> },
    key,
    salt as Uint8Array<ArrayBuffer>
  );

  return {
    encryptedSalt: toBase64(new Uint8Array(encrypted)),
    saltNonce: toBase64(nonce),
  };
}

/**
 * Decrypt the user salt with a password-derived key.
 * Throws SaltDecryptionError if decryption fails (wrong password).
 */
export async function decryptSalt(
  encryptedSaltBase64: string,
  saltNonceBase64: string,
  password: string,
  username: string
): Promise<Uint8Array> {
  const key = await deriveSaltEncryptionKey(password, username);
  const encryptedSalt = fromBase64(encryptedSaltBase64);
  const nonce = fromBase64(saltNonceBase64);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer> },
      key,
      encryptedSalt as Uint8Array<ArrayBuffer>
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new SaltDecryptionError();
  }
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
    return !this._isLoggedIn && sessionStorage.getItem(SESSION_STATE_KEY) === 'active';
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
  private async cacheSessionKeys(userSalt: Uint8Array, accountSalt: Uint8Array): Promise<void> {
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
    this._currentUser = user ?? await api.getCurrentUser();

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
        username
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

    // Account salt is derived from user ID for deterministic derivation
    const accountSalt = new TextEncoder().encode(this._currentUser.id).slice(0, 16);
    const paddedAccountSalt = new Uint8Array(16);
    paddedAccountSalt.set(accountSalt);

    // Initialize crypto worker with password and salts
    // Use wrapped account key if available to preserve identity
    const cryptoClient = await getCryptoClient();
    if (this._currentUser.wrappedAccountKey) {
      const wrappedKey = fromBase64(this._currentUser.wrappedAccountKey);
      await cryptoClient.initWithWrappedKey(password, userSalt, paddedAccountSalt, wrappedKey);
    } else {
      log.warn('Session restore without wrapped account key - identity may differ!');
      await cryptoClient.init(password, userSalt, paddedAccountSalt);
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
    await this.cacheSessionKeys(userSalt, paddedAccountSalt);

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
        username
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
      const { encryptedSalt, saltNonce } = await encryptSalt(userSalt, password, username);
      await api.updateCurrentUser({ encryptedSalt, saltNonce });
    }

    // Account salt is derived from user ID for deterministic derivation
    // This ensures the same keys are derived regardless of device
    const accountSalt = new TextEncoder().encode(this._currentUser.id).slice(0, 16);
    
    // Pad to 16 bytes if user ID is shorter
    const paddedAccountSalt = new Uint8Array(16);
    paddedAccountSalt.set(accountSalt);

    // Initialize crypto worker with password and salts
    // Use wrapped account key if available to preserve identity
    const cryptoClient = await getCryptoClient();
    if (this._currentUser.wrappedAccountKey) {
      const wrappedKey = fromBase64(this._currentUser.wrappedAccountKey);
      await cryptoClient.initWithWrappedKey(password, userSalt, paddedAccountSalt, wrappedKey);
    } else {
      // First login - generate new key and store it
      await cryptoClient.init(password, userSalt, paddedAccountSalt);
      
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
          body: JSON.stringify({ wrappedAccountKey: toBase64(wrappedAccountKey) }),
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
    await this.cacheSessionKeys(userSalt, paddedAccountSalt);

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
    const { userId, userSalt, accountSalt, isNewUser, wrappedAccountKey } = await localAuthLogin(username, password);

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
      await cryptoClient.initWithWrappedKey(password, userSalt, accountSalt, wrappedAccountKey);
    } else if (!isNewUser) {
      // Returning user but no wrapped key on server - this is a problem!
      // Fall back to generating new key (will break epoch key decryption)
      log.warn('Returning user without wrapped account key - identity will differ!');
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

    log.info(`LocalAuth login successful: ${username} (${userId})${isNewUser ? ' [new user]' : ''}`);
  }

  /**
   * Log out and clear all session data
   */
  async logout(): Promise<void> {
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

    // Clear epoch keys from memory
    clearAllEpochKeys();

    // Clear key cache encryption key
    clearCacheEncryptionKey();

    // Close all workers and clear keys
    await closeDbClient();
    await closeCryptoClient();
    closeGeoClient();

    // Clear session state
    this._currentUser = null;
    sessionStorage.clear();

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
