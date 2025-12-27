import { getDbClient, closeDbClient } from './db-client';
import { getCryptoClient, closeCryptoClient } from './crypto-client';
import { closeGeoClient } from './geo-client';
import { getApi, toBase64, fromBase64 } from './api';
import { clearAllEpochKeys } from './epoch-key-store';
import { clearAllCachedMetadata } from './album-metadata-service';
import { clearAllCovers } from './album-cover-service';
import { getIdleTimeoutMs, subscribeToSettings } from './settings-service';
import type { User } from './api-types';

/** Events that reset the idle timer */
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;

/** Salt storage key in localStorage */
const USER_SALT_KEY = 'mosaic:userSalt';

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
   * Log in with password
   * Initializes crypto and database workers
   */
  async login(password: string): Promise<void> {
    // Request persistent storage for OPFS
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        console.warn('Persistent storage not granted - data may be evicted');
      }
    }

    // Get current user from backend (authenticated via reverse proxy)
    const api = getApi();
    this._currentUser = await api.getCurrentUser();

    // Get or generate user salt
    // Salt is stored locally and used for Argon2id key derivation
    let userSalt: Uint8Array;
    const storedSalt = localStorage.getItem(USER_SALT_KEY);
    
    if (storedSalt) {
      userSalt = fromBase64(storedSalt);
    } else {
      // First login on this device - generate a new salt
      userSalt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem(USER_SALT_KEY, toBase64(userSalt));
    }

    // Account salt is derived from user ID for deterministic derivation
    // This ensures the same keys are derived regardless of device
    const accountSalt = new TextEncoder().encode(this._currentUser.id).slice(0, 16);
    
    // Pad to 16 bytes if user ID is shorter
    const paddedAccountSalt = new Uint8Array(16);
    paddedAccountSalt.set(accountSalt);

    // Initialize crypto worker with password and salts
    const cryptoClient = await getCryptoClient();
    await cryptoClient.init(password, userSalt, paddedAccountSalt);

    // Derive identity keypair for epoch key operations
    // This is needed to open sealed epoch key bundles
    await cryptoClient.deriveIdentity();

    // Initialize database worker with session key
    const db = await getDbClient();
    const sessionKey = await cryptoClient.getSessionKey();
    await db.init(sessionKey);

    this._isLoggedIn = true;
    this.notify();

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
      console.log('Session idle timeout - logging out');
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
