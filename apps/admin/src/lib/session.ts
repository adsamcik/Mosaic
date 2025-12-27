import { getDbClient, closeDbClient } from './db-client';
import { getCryptoClient, closeCryptoClient } from './crypto-client';
import { closeGeoClient } from './geo-client';

/** Idle timeout in milliseconds (30 minutes) */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Events that reset the idle timer */
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;

type SessionListener = () => void;

/**
 * Session Manager
 * Handles user authentication state, worker initialization, and idle timeout
 */
class SessionManager {
  private idleTimer: number | null = null;
  private _isLoggedIn = false;
  private listeners = new Set<SessionListener>();
  private boundResetIdleTimer: () => void;

  constructor() {
    this.boundResetIdleTimer = this.resetIdleTimer.bind(this);
  }

  /** Whether user is currently logged in */
  get isLoggedIn(): boolean {
    return this._isLoggedIn;
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

    // Initialize crypto worker with password
    const crypto = await getCryptoClient();
    
    // TODO: Fetch user salt from server based on username
    // For now, use placeholder salts
    const userSalt = new Uint8Array(16);
    const accountSalt = new Uint8Array(16);
    
    await crypto.init(password, userSalt, accountSalt);

    // Initialize database worker with session key
    const db = await getDbClient();
    const sessionKey = await crypto.getSessionKey();
    await db.init(sessionKey);

    this._isLoggedIn = true;
    this.notify();

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

    // Remove activity listeners
    this.detachIdleListeners();

    // Close all workers and clear keys
    await closeDbClient();
    await closeCryptoClient();
    closeGeoClient();

    // Clear session storage
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
    }, IDLE_TIMEOUT_MS);
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
