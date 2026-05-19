import { generateUserSaltBytes as rustGenerateUserSaltBytes } from '../generated/mosaic-wasm/mosaic_wasm.js';
import { clearAllCovers } from './album-cover-service';
import { clearAllCachedMetadata } from './album-metadata-service';
import {
  fromBase64,
  getApi,
  toBase64,
  type SessionExpiredReason,
} from './api';
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
import {
  ACTIVITY_EVENTS,
  makeDbCryptoBridge,
  SESSION_BROADCAST_CHANNEL,
  SESSION_STATE_KEY,
  UPLOAD_ACTIVE_EVENT,
} from './session-bridge';
import {
  WrappedKeyConflictError,
  resolveAccountSalt,
  resolveKdfProfile,
  toWorkerKdfParams,
} from './session-kdf';
import {
  USER_SALT_KEY,
  assertSaltMatchesServerEnvelope,
  consumeWasmBytesResult,
  decryptSalt,
  encryptSalt,
  ensureRustWasmInitialized,
  isV2SaltEnvelope,
  requireCachedV2BootstrapSalt,
} from './session-salt';
import { getIdleTimeoutMs, subscribeToSettings } from './settings-service';
import { syncCoordinator } from './sync-coordinator';

const log = createLogger('session');

// Backward-compatible re-exports for the public session API.
// External consumers import these names directly from './session'.
export { subscribeToSessionExpired } from './api';
export {
  SaltDecryptionError,
  decryptSalt,
  encryptSalt,
} from './session-salt';
export { WrappedKeyConflictError } from './session-kdf';

type SessionListener = () => void;

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
  private boundUploadActiveListener: (event: Event) => void;
  private boundPageShowListener: (event: PageTransitionEvent) => void;
  private settingsUnsubscribe: (() => void) | null = null;
  private uploadInProgress = false;
  private sessionExpiredHandled = false;

  /**
   * Concurrency guard for login-style entry points (M3).
   *
   * `login`, `localLogin`, `localRegister`, `restoreSession`, and
   * `restoreFromCache` all initialise the crypto/db workers and call
   * `cacheSessionKeys`. If two of them run in parallel — e.g. a stale
   * `restoreFromCache` triggered by a navigation event interleaving with
   * the user re-entering their password — they race each other and the
   * second one to call `cacheKeys` wins, possibly with stale data.
   *
   * All of the entry points share this single in-flight promise. The
   * second concurrent call rejects with "Login already in progress"
   * instead of corrupting the cached-keys store.
   */
  private loginInFlight: Promise<void> | null = null;

  /**
   * BroadcastChannel for cross-tab logout propagation (L2).
   *
   * `logout()` posts `{ type: 'logout' }` so other tabs (which still
   * hold decrypted state in their crypto/db workers) can clear their
   * own state immediately rather than waiting for the next API call to
   * fail. `null` on browsers that don't support BroadcastChannel and in
   * test environments where it isn't polyfilled.
   */
  private broadcast: BroadcastChannel | null = null;
  /**
   * Active DB-crypto bridge disposers. Flipped on `dispose()` so any
   * post-dispose `wrap`/`unwrap` callback from the DB worker fails fast
   * with `WorkerCryptoError(ClosedHandle)` instead of hitting a torn-down
   * Comlink port (v1.0.x `comlink-bridge-liveness`).
   */
  private dbBridgeDisposers = new Set<() => void>();

  constructor() {
    this.boundResetIdleTimer = this.resetIdleTimer.bind(this);
    this.boundUploadActiveListener = this.handleUploadActiveEvent.bind(this);
    this.boundPageShowListener = this.handlePageShow.bind(this);
    this.initBroadcastChannel();
    this.initSessionExpiryListener();
    this.attachPageShowListener();
  }

  /**
   * Wire up the cross-tab logout BroadcastChannel (L2). Safe to call in
   * environments without BroadcastChannel — the method short-circuits
   * and `this.broadcast` stays `null`.
   */
  private initBroadcastChannel(): void {
    if (typeof BroadcastChannel === 'undefined') {
      return;
    }
    try {
      this.broadcast = new BroadcastChannel(SESSION_BROADCAST_CHANNEL);
      this.broadcast.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as {
          type?: string;
          reason?: SessionExpiredReason;
        } | null | undefined;
        if (data?.type === 'logout' && this._isLoggedIn) {
          // Another tab logged out — drop our state too. Pass
          // skipBroadcast to avoid a re-broadcast loop. Any error
          // tearing down our state is logged but swallowed: it is
          // never useful to surface an error from a peer-tab's
          // logout to a global unhandled-rejection handler.
          this.logout({ skipBroadcast: true }).catch((error: unknown) => {
            log.warn('Cross-tab logout teardown failed', { error });
          });
        }
        if (data?.type === 'session-expired') {
          this.handleSessionExpired(data.reason ?? 'unknown', {
            skipBroadcast: true,
          });
        }
      });
    } catch (error) {
      log.warn('Failed to initialise session BroadcastChannel', { error });
      this.broadcast = null;
    }
  }

  /**
   * C4: subscribe to the global `mosaic:session-expired` event emitted by
   * `apiRequest` when the backend returns 401. We only react if we are
   * currently logged in — otherwise the 401 is from a login attempt
   * (wrong credentials) and must NOT be treated as expiry.
   *
   * On real expiry we tear down only volatile client auth state. We must
   * not call logout here: the backend has already returned 401, so another
   * API call would recurse into the same failure while upload progress
   * persisted in IndexedDB should remain resumable after re-login.
   */
  private initSessionExpiryListener(): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.addEventListener('mosaic:session-expired', () => {
      if (!this._isLoggedIn) {
        return;
      }
      log.warn('Server returned 401 mid-session; tearing down local state');
      this.handleSessionExpired('cookie-expired');
    });
  }

  /**
   * Run a login-style entry point under the M3 re-entrancy guard.
   * Concurrent callers reject immediately with "Login already in progress".
   */
  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    if (this.loginInFlight) {
      throw new Error('Login already in progress');
    }
    this.loginInFlight = operation();
    try {
      await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
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

  private markLoggedIn(): void {
    this.sessionExpiredHandled = false;
    this._isLoggedIn = true;
    this.markSessionActive();
    this.notify();
  }

  private clearSessionExpiredState(): void {
    if (this.idleTimer !== null) {
      this.clearIdleTimer();
    }

    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }

    this.detachIdleListeners();
    this.detachUploadActiveListener();
    this.uploadInProgress = false;

    clearAllCachedMetadata();
    clearAllCovers();
    clearPlaceholderCache();
    clearPhotoCache();
    syncCoordinator.dispose();
    clearAllEpochKeys();
    clearCacheEncryptionKey();
    clearLinkKeyEncryption();

    void closeDbClient().catch((error: unknown) => {
      log.warn('Failed to close DB client after session expiry', { error });
    });
    void closeCryptoClient().catch((error: unknown) => {
      log.warn('Failed to close crypto client after session expiry', { error });
    });
    closeGeoClient();

    this._currentUser = null;
    sessionStorage.removeItem(SESSION_STATE_KEY);
    this._isLoggedIn = false;
  }

  handleSessionExpired(
    reason: SessionExpiredReason = 'unknown',
    options: { skipBroadcast?: boolean } = {},
  ): void {
    if (this.sessionExpiredHandled) {
      return;
    }
    this.sessionExpiredHandled = true;

    if (!options.skipBroadcast && this.broadcast) {
      try {
        this.broadcast.postMessage({ type: 'session-expired', reason });
      } catch (error) {
        log.warn('Failed to broadcast session expiry', { error });
      }
    }

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('mosaic:session-expired', { detail: { reason } }),
        );
      } catch {
        // Non-browser test environments may not support CustomEvent.
      }
    }

    this.clearSessionExpiredState();
    this.notify();
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
      this.clearIdleTimer();
    }

    // Unsubscribe from settings changes and activity listeners
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }
    this.detachIdleListeners();
    this.detachUploadActiveListener();
    this.uploadInProgress = false;

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
   * Restore session from cached state (no password required).
   *
   * Slice 2 cutover: this previously rebuilt the worker by re-importing
   * raw key bytes via `importKeys`. The new contract requires the
   * password to re-derive L1 → unwrap L2 (zero-knowledge invariant), so
   * `restoreFromCache` now no-ops when only the cache is available — it
   * returns `false` and lets the regular login flow prompt the user.
   *
   * The cache *is* still useful: a follow-up `restoreSession(password)`
   * call can read the cached salts (without decrypting the opaque
   * session-state blob) to skip the salt-decryption round-trip. That
   * optimisation is intentionally deferred; for now we treat the cache
   * as opaque and bail out.
   *
   * Serialised against the other login-style entry points via the M3
   * re-entrancy guard. Concurrent callers reject with
   * "Login already in progress".
   */
  async restoreFromCache(): Promise<boolean> {
    let outcome = false;
    await this.runExclusive(async () => {
      const cachedKeys = await getCachedKeys();
      if (!cachedKeys) {
        log.debug('No cached keys available for restore');
        return;
      }

      // Slice 2 hard cutover: the cached blob is now opaque
      // (`serializeSessionState` output) and cannot be re-imported
      // without the user's password to re-derive L1. Keep the cache for
      // future restoreSession()-via-password flows but report failure
      // here so the caller falls back to the normal login screen.
      log.info(
        'restoreFromCache: cached session state cannot be opened without password (Slice 2). Falling back to login.',
      );
      outcome = false;
    });
    return outcome;
  }

  /**
   * Mark session state as active (called after successful login)
   */
  private markSessionActive(): void {
    sessionStorage.setItem(SESSION_STATE_KEY, 'active');
  }

  /**
   * Cache session-state for restoration after page reload.
   * Only caches if key caching is enabled in settings.
   *
   * Slice 2: the cached payload is now an OPAQUE
   * `serializeSessionState()` blob (versioned binary bundle of wrapped
   * account key + wrapped identity seed + auth public key). The user's
   * password is still required on the next reload to re-open the
   * handles via `restoreSessionState`.
   */
  private async cacheSessionKeys(
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
  ): Promise<void> {
    try {
      const cryptoClient = await getCryptoClient();
      const sessionState = await cryptoClient.serializeSessionState();
      if (!sessionState) {
        log.warn(
          'Failed to serialize session state for caching - worker not initialized',
        );
        return;
      }

      const cachedKeys: CachedKeys = {
        sessionState: toBase64(sessionState),
        userSalt: toBase64(userSalt),
        accountSalt: toBase64(accountSalt),
        version: 2,
      };

      await cacheKeys(cachedKeys);
    } catch (error) {
      log.error('Failed to cache session keys:', error);
      // Non-fatal - session will require password on reload
    }
  }

  private async clearWorkerStateAfterPostInitVerificationFailure(): Promise<void> {
    await this.clearCorruptedSession();
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
    await this.runExclusive(async () => {
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
      let shouldUploadUserSalt = false;
      const username = this._currentUser.authSub ?? this._currentUser.id;
      const kdfParams = resolveKdfProfile(this._currentUser);
      const workerKdfParams = toWorkerKdfParams(kdfParams);

      if (this._currentUser.encryptedSalt && this._currentUser.saltNonce) {
        // Server has salt - decrypt it with password
        // If decryption fails, password is wrong - throw error
        const saltEnvelope = fromBase64(this._currentUser.encryptedSalt);
        shouldUploadUserSalt = !isV2SaltEnvelope(saltEnvelope);
        userSalt = shouldUploadUserSalt
          ? await decryptSalt(
              this._currentUser.encryptedSalt,
              this._currentUser.saltNonce,
              password,
              username,
              kdfParams,
              false,
            )
          : requireCachedV2BootstrapSalt();
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
          workerKdfParams,
        );
      } else {
        log.warn(
          'Session restore without wrapped account key - identity may differ!',
        );
        await cryptoClient.init(password, userSalt, accountSalt, workerKdfParams);
      }

      // Derive identity keypair for epoch key operations
      await cryptoClient.deriveIdentity();

      if (
        this._currentUser.encryptedSalt &&
        this._currentUser.saltNonce &&
        !shouldUploadUserSalt
      ) {
        try {
          const serverSalt = await decryptSalt(
            this._currentUser.encryptedSalt,
            this._currentUser.saltNonce,
            password,
            username,
            kdfParams,
            false,
          );
          assertSaltMatchesServerEnvelope(userSalt, serverSalt);
        } catch (error) {
          await this.clearWorkerStateAfterPostInitVerificationFailure();
          throw error;
        }
      }

      if (shouldUploadUserSalt) {
        const { encryptedSalt, saltNonce } = await encryptSalt(
          userSalt,
          password,
          username,
          kdfParams,
        );
        await api.updateCurrentUser({ encryptedSalt, saltNonce });
      }

      // Slice 8: bridge OPFS snapshot wrap/unwrap through the crypto
      // worker — the DB worker no longer holds raw key bytes.
      const db = await getDbClient();
      await db.init(this.attachDbCryptoBridge(cryptoClient));

      this.markLoggedIn();

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
      this.attachUploadActiveListener();
    });
  }

  /**
   * Log in with password
   * Initializes crypto and database workers.
   * Syncs user salt with server for multi-device support.
   * @throws SaltDecryptionError if server has salt but decryption fails (wrong password)
   * @throws WrappedKeyConflictError if another device wins the first-login race (M4)
   */
  async login(password: string): Promise<void> {
    await this.runExclusive(async () => {
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
      let shouldUploadUserSalt = false;
      const username = this._currentUser.authSub ?? this._currentUser.id;
      const kdfParams = resolveKdfProfile(this._currentUser);
      const workerKdfParams = toWorkerKdfParams(kdfParams);

      if (this._currentUser.encryptedSalt && this._currentUser.saltNonce) {
        // Server has salt - decrypt it (new device or returning user)
        // If decryption fails, password is wrong - throw error
        const saltEnvelope = fromBase64(this._currentUser.encryptedSalt);
        shouldUploadUserSalt = !isV2SaltEnvelope(saltEnvelope);
        userSalt = shouldUploadUserSalt
          ? await decryptSalt(
              this._currentUser.encryptedSalt,
              this._currentUser.saltNonce,
              password,
              username,
              kdfParams,
              false,
            )
          : requireCachedV2BootstrapSalt();
        // Store locally for faster subsequent logins
        localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));
      } else {
        // Server has no salt - use local or generate new
        const storedSalt = localStorage.getItem(USER_SALT_KEY);

        if (storedSalt) {
          userSalt = fromBase64(storedSalt);
        } else {
          // First login ever - generate a new salt
          await ensureRustWasmInitialized();
          userSalt = consumeWasmBytesResult(
            rustGenerateUserSaltBytes(),
            'generateUserSaltBytes',
          );
          localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));
        }

        shouldUploadUserSalt = true;
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
          workerKdfParams,
        );
      } else {
        // First login - generate new key and store it
        await cryptoClient.init(password, userSalt, accountSalt, workerKdfParams);

        // Derive identity to get public key
        await cryptoClient.deriveIdentity();

        // Save wrapped key and identity pubkey to server for future logins.
        const wrappedAccountKey = await cryptoClient.getWrappedAccountKey();
        const identityPubkey = await cryptoClient.getIdentityPublicKey();
        if (wrappedAccountKey && identityPubkey) {
          // M4: re-fetch /users/me before the wrapped-key PUT to detect a
          // concurrent first-login from another device. Threat model: if
          // two devices belonging to the same user arrive at this branch
          // simultaneously, each will generate its own L2 account key and
          // attempt to PUT it. Without this guard, the loser silently
          // clobbers the winner's wrapped key, breaking the winner on
          // their next login. With it, we observe the winning upload via
          // the latest user record and surface a recoverable
          // WrappedKeyConflictError so the caller re-runs login() — that
          // second pass takes the "wrapped key present" branch above and
          // unwraps successfully with the shared password.
          const latestUser = await api.getCurrentUser();
          if (latestUser.wrappedAccountKey) {
            log.warn(
              'Concurrent first-login detected (M4) - aborting wrapped-key upload',
            );
            throw new WrappedKeyConflictError();
          }

          await api.updateCurrentUser({
            identityPubkey: toBase64(identityPubkey),
          });

          // M9: route the wrapped-key PUT through the centralised API
          // client so failures surface as ApiError (instead of a silently
          // swallowed raw fetch). A failure here propagates out of login()
          // — the caller can prompt for retry.
          await api.updateCurrentUserWrappedKey(wrappedAccountKey);
        }
      }

      // Derive identity keypair for epoch key operations
      // This is needed to open sealed epoch key bundles
      await cryptoClient.deriveIdentity();

      if (
        this._currentUser.encryptedSalt &&
        this._currentUser.saltNonce &&
        !shouldUploadUserSalt
      ) {
        try {
          const serverSalt = await decryptSalt(
            this._currentUser.encryptedSalt,
            this._currentUser.saltNonce,
            password,
            username,
            kdfParams,
            false,
          );
          assertSaltMatchesServerEnvelope(userSalt, serverSalt);
        } catch (error) {
          await this.clearWorkerStateAfterPostInitVerificationFailure();
          throw error;
        }
      }

      if (shouldUploadUserSalt) {
        const { encryptedSalt, saltNonce } = await encryptSalt(
          userSalt,
          password,
          username,
          kdfParams,
        );
        await api.updateCurrentUser({ encryptedSalt, saltNonce });
      }

      // Slice 8: bridge OPFS snapshot wrap/unwrap through the crypto
      // worker — the DB worker no longer holds raw key bytes.
      const db = await getDbClient();
      await db.init(this.attachDbCryptoBridge(cryptoClient));

      this.markLoggedIn();

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
      this.attachUploadActiveListener();
    });
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
    await this.runExclusive(async () => {
      // Request persistent storage for OPFS
      if (navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        if (!granted) {
          log.warn('Persistent storage not granted - data may be evicted');
        }
      }

      // Perform LocalAuth login (registers if user doesn't exist)
      const {
        userId,
        userSalt,
        accountSalt,
        isNewUser,
        wrappedAccountKey,
        wrappedIdentitySeed,
        kdfParams,
      } =
        await localAuthLogin(username, password);
      const workerKdfParams = toWorkerKdfParams(kdfParams);

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
        // Returning user: unwrap their existing account key AND identity
        // seed so the Ed25519/X25519 identity is deterministically
        // restored. Without `wrappedIdentitySeed` the worker would mint
        // a fresh random identity and break every previously-sealed
        // epoch bundle (v1.0.x `bundle-seal-222`, rust code 222).
        await cryptoClient.initWithWrappedKey(
          password,
          userSalt,
          accountSalt,
          wrappedAccountKey,
          workerKdfParams,
          wrappedIdentitySeed ?? undefined,
        );
      } else if (!isNewUser) {
        // Returning user but no wrapped key on server - this is a problem!
        // Fall back to generating new key (will break epoch key decryption)
        log.warn(
          'Returning user without wrapped account key - identity will differ!',
        );
        await cryptoClient.init(password, userSalt, accountSalt, workerKdfParams);
      }
      // For new users, localAuthLogin already called init() with correct key
      await cryptoClient.deriveIdentity();

      // Slice 8: bridge OPFS snapshot wrap/unwrap through the crypto
      // worker — the DB worker no longer holds raw key bytes.
      const db = await getDbClient();
      await db.init(this.attachDbCryptoBridge(cryptoClient));

      this.markLoggedIn();

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
      this.attachUploadActiveListener();

      log.info(
        `LocalAuth login successful: ${username} (${userId})${isNewUser ? ' [new user]' : ''}`,
      );
    });
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
    await this.runExclusive(async () => {
      // Request persistent storage for OPFS
      if (navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        if (!granted) {
          log.warn('Persistent storage not granted - data may be evicted');
        }
      }

      // Perform LocalAuth registration (will fail if user exists)
      const {
        userId,
        userSalt,
        accountSalt,
        wrappedAccountKey,
        wrappedIdentitySeed,
        kdfParams,
      } =
        await localAuthRegister(username, password);
      const workerKdfParams = toWorkerKdfParams(kdfParams);

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
          workerKdfParams,
          wrappedIdentitySeed ?? undefined,
        );
      }
      await cryptoClient.deriveIdentity();

      // Slice 8: bridge OPFS snapshot wrap/unwrap through the crypto
      // worker — the DB worker no longer holds raw key bytes.
      const db = await getDbClient();
      await db.init(this.attachDbCryptoBridge(cryptoClient));

      this.markLoggedIn();

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
      this.attachUploadActiveListener();

      log.info(`LocalAuth registration successful: ${username} (${userId})`);
    });
  }

  /**
   * Log out and clear all session data.
   *
   * `localStorage` survives logout intentionally (L1).
   * - `mosaic:userSalt` (16-byte random salt for Argon2id) and the i18n
   *   language preference are the only entries we keep.
   * - The user salt is **non-secret**: without the password it produces
   *   no usable key material. Persisting it across logouts means the
   *   next login on this device skips a server round-trip for salt
   *   retrieval, which is only a performance optimisation but matters
   *   on slow connections.
   * - `sessionStorage` *is* cleared (the active-session marker and any
   *   tab-scoped cached keys live there), and the workers are closed,
   *   so all decrypted material is dropped.
   * - Kiosk-style deployments that need full local amnesia should add
   *   a separate `clearAllLocalState()` method later — explicitly opt-in
   *   so the multi-device-friendly default is preserved.
   *
   * Cross-tab logout propagation (L2): when called locally we post a
   * `{ type: 'logout' }` message on the `mosaic-session` BroadcastChannel
   * so peer tabs clear their own decrypted state. When invoked in
   * response to an inbound message we pass `skipBroadcast: true` to
   * avoid a re-broadcast loop.
   */
  async logout(options: { skipBroadcast?: boolean } = {}): Promise<void> {
    // Broadcast first so peer tabs start their own teardown in parallel
    // with our backend logout call. We don't wait for them.
    if (!options.skipBroadcast && this.broadcast) {
      try {
        this.broadcast.postMessage({ type: 'logout' });
      } catch (error) {
        log.warn('Failed to broadcast logout', { error });
      }
    }

    // Call backend logout to revoke session and clear cookie
    try {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Ignore errors - continue with client-side cleanup
    }

    // Clear idle timer
    if (this.idleTimer !== null) {
      this.clearIdleTimer();
    }

    // Unsubscribe from settings changes
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }

    // Remove activity listeners
    this.detachIdleListeners();
    this.detachUploadActiveListener();
    this.uploadInProgress = false;

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

    // Clear session state. NOTE: localStorage is intentionally NOT
    // cleared — see the doc comment above. Only sessionStorage and the
    // in-memory user object are dropped.
    this._currentUser = null;
    sessionStorage.clear();

    // Reset URL to root when logging out (clean slate)
    if (window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }

    this._isLoggedIn = false;

    // Tear down the BroadcastChannel after the broadcast has been posted
    // so this manager stops responding to peer logouts (it has nothing
    // useful left to do). A fresh SessionManager (next page load) will
    // recreate it. Done after `_isLoggedIn = false` so any late-arriving
    // self-broadcast is a no-op.
    if (this.broadcast) {
      try {
        this.broadcast.close();
      } catch (error) {
        log.warn('Failed to close session BroadcastChannel', { error });
      }
      this.broadcast = null;
    }

    this.notify();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.clearIdleTimer();
    }

    this.idleTimer = window.setTimeout(() => {
      if (this.uploadInProgress) {
        log.info('Session idle timeout deferred while upload is active');
        this.resetIdleTimer();
        return;
      }
      log.info('Session idle timeout - logging out');
      void this.logout();
    }, getIdleTimeoutMs());
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private handleUploadActiveEvent(event: Event): void {
    const detail = (event as CustomEvent<{ active?: unknown }>).detail;
    this.uploadInProgress = detail?.active === true;

    if (!this._isLoggedIn) {
      return;
    }

    if (this.uploadInProgress) {
      this.clearIdleTimer();
      return;
    }

    this.resetIdleTimer();
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

  private attachUploadActiveListener(): void {
    window.addEventListener(UPLOAD_ACTIVE_EVENT, this.boundUploadActiveListener);
  }

  private detachUploadActiveListener(): void {
    window.removeEventListener(UPLOAD_ACTIVE_EVENT, this.boundUploadActiveListener);
  }

  /**
   * v1.0.x s49-y2: handle restoration from the back-forward (BFCache).
   *
   * When the browser restores a page from BFCache, JS state is preserved
   * but the idle timer (which is a real `setTimeout`) may have expired
   * during the time the page was cached, immediately tripping logout on
   * navigation back. We listen for `pageshow` events with `persisted=true`
   * and, if the user is still logged in, refresh the idle timer so they
   * get a full idle window after returning. Non-persisted pageshow events
   * (i.e. normal navigation/refresh) are ignored — those go through the
   * usual init paths.
   */
  private handlePageShow(event: PageTransitionEvent): void {
    if (!event.persisted) return;
    log.info('Page restored from BFCache; resetting idle timer');
    if (this._isLoggedIn) {
      this.resetIdleTimer();
    }
  }

  private attachPageShowListener(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('pageshow', this.boundPageShowListener);
  }

  /**
   * Tear down listeners and the broadcast channel. The module-level
   * `session` export is a process-singleton, but this is exposed for
   * tests that need to instantiate isolated SessionManagers AND for any
   * future refactor that makes SessionManager lifecycle non-singleton
   * (so the BFCache pageshow listener, upload-active listener, and
   * BroadcastChannel don't leak across reinstantiation). Closes
   * security-review-2026-05-18-05.
   */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', this.boundPageShowListener);
      window.removeEventListener(UPLOAD_ACTIVE_EVENT, this.boundUploadActiveListener);
    }
    if (this.broadcast) {
      this.broadcast.close();
      this.broadcast = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // security-review-2026-05-19-03: match logout cleanup so disposed
    // SessionManagers do not leak the settings subscription or the
    // document-level activity listeners (mousemove / keydown / etc).
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }
    this.detachIdleListeners();
    // v1.0.x comlink-bridge-liveness: flip all active DB-crypto bridges so
    // any post-dispose `wrap`/`unwrap` callback from the DB worker fails
    // with `WorkerCryptoError(ClosedHandle)` rather than crashing on a
    // closed Comlink port with "rawValue.apply is not a function".
    for (const disposeBridge of this.dbBridgeDisposers) {
      try {
        disposeBridge();
      } catch {
        // best-effort
      }
    }
    this.dbBridgeDisposers.clear();
  }

  /**
   * Build a DB-crypto bridge and track its disposer so it gets torn down
   * with the SessionManager. See `comlink-bridge-liveness`.
   */
  private attachDbCryptoBridge(
    cryptoClient: Parameters<typeof makeDbCryptoBridge>[0],
  ): ReturnType<typeof makeDbCryptoBridge>['bridge'] {
    const handle = makeDbCryptoBridge(cryptoClient);
    this.dbBridgeDisposers.add(handle.dispose);
    return handle.bridge;
  }
}

/** Global session manager instance */
export const session = new SessionManager();
