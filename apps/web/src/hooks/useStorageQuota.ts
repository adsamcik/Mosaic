import { useCallback, useEffect, useState } from 'react';
import { createLogger } from '../lib/logger';
import {
  DEFAULT_STORAGE_PRESSURE_THRESHOLD,
  isStorageCritical,
  isStorageUnderPressure,
  readStorageQuota,
  type StorageQuotaSnapshot,
} from '../lib/storage-quota';

const log = createLogger('useStorageQuota');

const SESSION_DISMISS_KEY = 'mosaic.storage-pressure.dismissed';
const DISMISS_VALUE = '1';

/** Default poll interval: 60 seconds. */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface UseStorageQuotaOptions {
  /** Pressure threshold in (0, 1]. Defaults to {@link DEFAULT_STORAGE_PRESSURE_THRESHOLD}. */
  readonly threshold?: number | undefined;
  /** Poll interval in milliseconds. Defaults to 60s. */
  readonly pollIntervalMs?: number | undefined;
  /** When true, suppresses polling (used in tests and SSR). */
  readonly disabled?: boolean | undefined;
}

export interface UseStorageQuotaResult {
  /** Current snapshot. `null` until the first probe resolves. */
  readonly snapshot: StorageQuotaSnapshot | null;
  /** Whether the user has dismissed the banner for this session. */
  readonly dismissedThisSession: boolean;
  /** True when snapshot crosses the supplied threshold and isn't dismissed. */
  readonly underPressure: boolean;
  /** True when snapshot crosses the critical (95%) threshold. */
  readonly critical: boolean;
  /** Force a re-probe (e.g. after a download). */
  readonly refresh: () => Promise<void>;
  /** Dismiss the banner for the current session only. */
  readonly dismiss: () => void;
}

function getSessionStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readDismissFlag(): boolean {
  const storage = getSessionStorage();
  if (!storage) return false;
  try {
    return storage.getItem(SESSION_DISMISS_KEY) === DISMISS_VALUE;
  } catch {
    return false;
  }
}

function writeDismissFlag(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(SESSION_DISMISS_KEY, DISMISS_VALUE);
  } catch {
    // ignore privacy / quota errors — dismissal is best-effort
  }
}

/**
 * React hook that polls `navigator.storage.estimate()` and exposes a
 * pressure-detection state suitable for driving an in-app banner.
 *
 * The hook is intentionally polling-based (not event-driven) because the
 * Storage Standard does not expose a `quotachange` event broadly supported
 * by browsers we target. A 60s interval is a reasonable trade-off between
 * responsiveness and battery / wakeup cost.
 *
 * Dismissal is session-scoped: the user can hide the banner for the rest
 * of the browser session, but it returns on the next session if the
 * pressure is still present (intentional — quota issues should never be
 * silently muted across sessions).
 */
export function useStorageQuota(options: UseStorageQuotaOptions = {}): UseStorageQuotaResult {
  const {
    threshold = DEFAULT_STORAGE_PRESSURE_THRESHOLD,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    disabled = false,
  } = options;

  const [snapshot, setSnapshot] = useState<StorageQuotaSnapshot | null>(null);
  const [dismissedThisSession, setDismissedThisSession] = useState<boolean>(() =>
    readDismissFlag(),
  );

  const refresh = useCallback(async (): Promise<void> => {
    const next = await readStorageQuota();
    setSnapshot(next);
    // ZK-safe logging: only the threshold-cross outcome, never raw byte counts.
    log.info('Storage quota probe', {
      supported: next.supported,
      overThreshold: isStorageUnderPressure(next, threshold),
    });
  }, [threshold]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    void (async (): Promise<void> => {
      const next = await readStorageQuota();
      if (cancelled) return;
      setSnapshot(next);
    })();

    const interval = setInterval(() => {
      void (async (): Promise<void> => {
        const next = await readStorageQuota();
        if (cancelled) return;
        setSnapshot(next);
      })();
    }, pollIntervalMs);

    return (): void => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [disabled, pollIntervalMs]);

  const dismiss = useCallback((): void => {
    writeDismissFlag();
    setDismissedThisSession(true);
    log.info('Storage pressure banner dismissed for session');
  }, []);

  const overThreshold = snapshot !== null && isStorageUnderPressure(snapshot, threshold);
  const critical = snapshot !== null && isStorageCritical(snapshot);

  return {
    snapshot,
    dismissedThisSession,
    underPressure: overThreshold && !dismissedThisSession,
    critical,
    refresh,
    dismiss,
  };
}
