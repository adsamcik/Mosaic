/**
 * useVisitorDownloadDisclosure — per-scope-key acknowledgement of the
 * pre-OPFS staging disclosure shown to anonymous share-link visitors.
 *
 * Acknowledgement is persisted in localStorage as a JSON array of scope
 * keys under {@link STORAGE_KEY}. A module-level Set mirrors the array
 * so reads are O(1) and writes only touch storage when the membership
 * actually changes. All hook instances share the cache and are notified
 * via {@link listeners} so a state change in one component re-renders
 * any others observing the same scope.
 *
 * **ZK-safety**: this module never logs a scope key. Callers that need
 * to log should use `scopeKeyPrefix()` from `lib/scope-key`.
 */
import { useCallback, useEffect, useState } from 'react';

/** localStorage key holding the JSON array of acknowledged scope keys. */
export const STORAGE_KEY = 'mosaic.visitor-disclosure.acknowledged';

export interface VisitorDisclosureState {
  /** True if the user has acknowledged the disclosure for this scope key. */
  readonly acknowledged: boolean;
  /** Mark the current scope as acknowledged. */
  readonly acknowledge: () => void;
  /** Reset acknowledgement for the current scope (for testing / "do over"). */
  readonly reset: () => void;
}

let cache: Set<string> | null = null;
const listeners = new Set<() => void>();

function load(): Set<string> {
  if (cache !== null) return cache;
  cache = readFromStorage();
  return cache;
}

function readFromStorage(): Set<string> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return new Set();
  }
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      // Corrupt payload — wipe and start clean.
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return new Set();
    }
    return new Set(parsed as readonly string[]);
  } catch {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return new Set();
  }
}

function persist(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Storage may be full or disabled (private mode). The in-memory cache
    // still holds the value for the rest of the session.
  }
}

function notify(): void {
  for (const cb of listeners) cb();
}

/**
 * Test-only: drop the in-memory cache so the next load() re-reads
 * localStorage. Components must be re-rendered (or remounted) for
 * them to observe the reset.
 */
export function __resetVisitorDisclosureCacheForTests(): void {
  cache = null;
  notify();
}

export function useVisitorDownloadDisclosure(
  scopeKey: string | null,
): VisitorDisclosureState {
  const [, setTick] = useState(0);

  useEffect(() => {
    const cb = (): void => setTick((t) => t + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  const set = load();
  const acknowledged = scopeKey !== null && set.has(scopeKey);

  const acknowledge = useCallback((): void => {
    if (scopeKey === null) return;
    const s = load();
    if (s.has(scopeKey)) return;
    s.add(scopeKey);
    persist(s);
    notify();
  }, [scopeKey]);

  const reset = useCallback((): void => {
    if (scopeKey === null) return;
    const s = load();
    if (!s.has(scopeKey)) return;
    s.delete(scopeKey);
    persist(s);
    notify();
  }, [scopeKey]);

  return { acknowledged, acknowledge, reset };
}
