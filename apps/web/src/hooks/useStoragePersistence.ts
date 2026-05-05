import { useCallback, useEffect, useState } from 'react';
import { createLogger } from '../lib/logger';

const log = createLogger('useStoragePersistence');

const SESSION_DISMISS_KEY = 'mosaic.persistence-prompt.dismissed';
const FOREVER_DISMISS_KEY = 'mosaic.persistence-prompt.never-ask';
const DISMISS_VALUE = '1';

/** Snapshot of promoted-storage state and dismissal flags. */
export interface StoragePersistenceState {
  /** Whether `navigator.storage.persist`/`persisted` are available. */
  readonly supported: boolean;
  /**
   * Current promoted state. `null` until the initial `persisted()` probe
   * resolves (or stays `null` forever when the API is unsupported).
   */
  readonly persisted: boolean | null;
  /** `true` when the user clicked "Not now" earlier in this session. */
  readonly dismissedThisSession: boolean;
  /** `true` when the user clicked "Don't ask again" in any past session. */
  readonly dismissedForever: boolean;
  /**
   * Request promoted persistence via `navigator.storage.persist()`.
   * Returns the resulting promoted state. Resolves `false` (never throws) when
   * unsupported or when the browser declines the request.
   */
  readonly request: () => Promise<boolean>;
  /** Mark the prompt as dismissed for this session only. */
  readonly dismiss: () => void;
  /** Persistently mark the prompt as dismissed; survives across sessions. */
  readonly dismissForever: () => void;
}

interface NavigatorStorageLike {
  readonly persist?: () => Promise<boolean>;
  readonly persisted?: () => Promise<boolean>;
}

function getStorageManager(): NavigatorStorageLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const storage = (navigator as Navigator & { storage?: NavigatorStorageLike }).storage;
  if (!storage) return undefined;
  if (typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') {
    return undefined;
  }
  return storage;
}

function readFlag(storage: Storage | undefined, key: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(key) === DISMISS_VALUE;
  } catch {
    return false;
  }
}

function writeFlag(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, DISMISS_VALUE);
  } catch {
    // ignore quota/privacy errors — dismissal is best-effort
  }
}

function getSessionStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * React hook around the Storage Standard `persist()` / `persisted()` API.
 *
 * The hook does not show any UI on its own — consumers (e.g. the
 * `<PersistencePrompt />` banner) read `state` and decide whether to prompt.
 * Dismissal is split into two scopes:
 *
 * - "Not now" → `sessionStorage` (re-prompts on next session)
 * - "Don't ask again" → `localStorage` (persistent)
 *
 * All logging is ZK-safe: we never log album/photo identifiers or storage
 * estimates, only the supported/persisted booleans and error names.
 */
export function useStoragePersistence(): StoragePersistenceState {
  const [supported, setSupported] = useState<boolean>(() => getStorageManager() !== undefined);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [dismissedThisSession, setDismissedThisSession] = useState<boolean>(
    () => readFlag(getSessionStorage(), SESSION_DISMISS_KEY),
  );
  const [dismissedForever, setDismissedForever] = useState<boolean>(
    () => readFlag(getLocalStorage(), FOREVER_DISMISS_KEY),
  );

  useEffect(() => {
    let cancelled = false;
    const storage = getStorageManager();
    if (!storage) {
      setSupported(false);
      setPersisted(null);
      return (): void => {
        cancelled = true;
      };
    }
    setSupported(true);
    storage.persisted!()
      .then((value) => {
        if (cancelled) return;
        setPersisted(value);
        log.info('Storage persisted probe', { persisted: value });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : 'Unknown';
        log.warn('Storage persisted probe failed', { errorName: name });
        setPersisted(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const request = useCallback(async (): Promise<boolean> => {
    const storage = getStorageManager();
    if (!storage) {
      log.info('Storage persist requested but unsupported');
      return false;
    }
    try {
      const result = await storage.persist!();
      setPersisted(result);
      log.info('Storage persist result', { persisted: result });
      return result;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Unknown';
      log.warn('Storage persist threw', { errorName: name });
      setPersisted(false);
      return false;
    }
  }, []);

  const dismiss = useCallback((): void => {
    writeFlag(getSessionStorage(), SESSION_DISMISS_KEY);
    setDismissedThisSession(true);
    log.info('Persistence prompt dismissed for session');
  }, []);

  const dismissForever = useCallback((): void => {
    writeFlag(getLocalStorage(), FOREVER_DISMISS_KEY);
    setDismissedForever(true);
    log.info('Persistence prompt dismissed forever');
  }, []);

  return {
    supported,
    persisted,
    dismissedThisSession,
    dismissedForever,
    request,
    dismiss,
    dismissForever,
  };
}
