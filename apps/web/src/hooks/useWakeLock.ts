import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '../lib/logger';

const log = createLogger('useWakeLock');

/** Reasons wake lock was released, for telemetry / debugging only. */
export type WakeLockReleaseReason =
  | 'manual'
  | 'browser'
  | 'visibility-hidden';

/** State of the current wake lock attempt. */
export interface WakeLockState {
  /** Whether `navigator.wakeLock` is available in this browser. */
  readonly supported: boolean;
  /** Whether the hook is currently holding a wake lock sentinel. */
  readonly active: boolean;
  /** Last acquire/release error, or `null` after a successful transition. */
  readonly lastError: Error | null;
  /** Last known release reason, for telemetry / debugging only. */
  readonly lastReleaseReason: WakeLockReleaseReason | null;
}

/** Result returned by {@link useWakeLock}. */
export interface UseWakeLockResult {
  /** Current wake lock support, active, error, and release metadata. */
  readonly state: WakeLockState;
  /** Acquire (or re-acquire) a screen wake lock. Idempotent; calling while active is a no-op. */
  acquire(): Promise<void>;
  /** Release the wake lock. Safe to call when not held. */
  release(): Promise<void>;
}

function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && navigator.wakeLock !== undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * React hook that manages a Screen Wake Lock for the lifetime of the caller component.
 *
 * Behavior:
 * - On `acquire()`, requests `navigator.wakeLock.request('screen')`.
 * - On `release()` or unmount, releases the lock cleanly.
 * - Listens for `document.visibilitychange`: when the page transitions
 *   `hidden → visible` AND the lock was active before being hidden, re-acquires.
 * - Listens for the lock sentinel's `release` event (browser-initiated revoke).
 * - Logs every transition to the scoped logger; never logs album/photo IDs.
 */
export function useWakeLock(): UseWakeLockResult {
  const [state, setState] = useState<WakeLockState>(() => ({
    supported: isWakeLockSupported(),
    active: false,
    lastError: null,
    lastReleaseReason: null,
  }));
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const releaseListenerRef = useRef<EventListener | null>(null);
  const acquirePromiseRef = useRef<Promise<void> | null>(null);
  const reacquireOnVisibleRef = useRef(false);

  const detachReleaseListener = useCallback((sentinel: WakeLockSentinel): void => {
    const releaseListener = releaseListenerRef.current;
    if (!releaseListener) {
      return;
    }

    sentinel.removeEventListener('release', releaseListener);
    releaseListenerRef.current = null;
  }, []);

  const releaseSentinel = useCallback(async (
    sentinel: WakeLockSentinel,
    reason: WakeLockReleaseReason,
  ): Promise<void> => {
    if (sentinelRef.current === sentinel) {
      sentinelRef.current = null;
    }
    detachReleaseListener(sentinel);
    if (reason === 'manual') {
      reacquireOnVisibleRef.current = false;
    }

    setState((current) => ({
      ...current,
      active: false,
      lastError: null,
      lastReleaseReason: reason,
    }));
    log.info('Wake lock released', { reason });

    try {
      await sentinel.release();
    } catch (error) {
      const releaseError = toError(error);
      setState((current) => ({
        ...current,
        active: false,
        lastError: releaseError,
        lastReleaseReason: reason,
      }));
      log.warn('Wake lock release failed', {
        reason,
        errorName: releaseError.name,
      });
    }
  }, [detachReleaseListener]);

  const releaseCurrent = useCallback(async (
    reason: WakeLockReleaseReason,
  ): Promise<void> => {
    const sentinel = sentinelRef.current;
    if (sentinel) {
      await releaseSentinel(sentinel, reason);
      return;
    }

    const acquirePromise = acquirePromiseRef.current;
    if (!acquirePromise) {
      return;
    }

    await acquirePromise;
    const acquiredSentinel = sentinelRef.current;
    if (acquiredSentinel) {
      await releaseSentinel(acquiredSentinel, reason);
    }
  }, [releaseSentinel]);
  const acquire = useCallback(async (): Promise<void> => {
    const existingSentinel = sentinelRef.current;
    if (existingSentinel && !existingSentinel.released) {
      return;
    }

    if (acquirePromiseRef.current) {
      await acquirePromiseRef.current;
      return;
    }

    const wakeLock = typeof navigator === 'undefined'
      ? undefined
      : navigator.wakeLock;
    if (!wakeLock) {
      setState((current) => ({
        ...current,
        supported: false,
        active: false,
        lastError: null,
      }));
      log.info('Wake lock unsupported');
      return;
    }

    const acquirePromise = (async (): Promise<void> => {
      try {
        const sentinel = await wakeLock.request('screen');
        const releaseListener: EventListener = (): void => {
          if (sentinelRef.current !== sentinel) {
            return;
          }

          detachReleaseListener(sentinel);
          sentinelRef.current = null;
          reacquireOnVisibleRef.current = false;
          setState((current) => ({
            ...current,
            active: false,
            lastError: null,
            lastReleaseReason: 'browser',
          }));
          log.info('Wake lock released', { reason: 'browser' });
        };

        sentinelRef.current = sentinel;
        releaseListenerRef.current = releaseListener;
        sentinel.addEventListener('release', releaseListener);
        setState({
          supported: true,
          active: true,
          lastError: null,
          lastReleaseReason: null,
        });
        log.info('Wake lock acquired');
      } catch (error) {
        const acquireError = toError(error);
        sentinelRef.current = null;
        setState((current) => ({
          ...current,
          supported: true,
          active: false,
          lastError: acquireError,
        }));
        log.info('Wake lock denied', { errorName: acquireError.name });
      } finally {
        acquirePromiseRef.current = null;
      }
    })();

    acquirePromiseRef.current = acquirePromise;
    await acquirePromise;
  }, [detachReleaseListener]);

  const release = useCallback(async (): Promise<void> => {
    await releaseCurrent('manual');
  }, [releaseCurrent]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        const sentinel = sentinelRef.current;
        reacquireOnVisibleRef.current = Boolean(sentinel && !sentinel.released);
        if (reacquireOnVisibleRef.current) {
          void releaseCurrent('visibility-hidden');
        }
        return;
      }

      if (document.visibilityState === 'visible' && reacquireOnVisibleRef.current) {
        reacquireOnVisibleRef.current = false;
        log.info('Wake lock reacquiring after visibility restore');
        void acquire().then(() => {
          if (sentinelRef.current) {
            log.info('Wake lock reacquired');
          }
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      reacquireOnVisibleRef.current = false;
      void releaseCurrent('manual');
    };
  }, [acquire, releaseCurrent]);

  return {
    state,
    acquire,
    release,
  };
}
