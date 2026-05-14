/**
 * Local-state purge for "Settings → Clear Local Data" and similar.
 *
 * The audit "privacy hygiene" (L4–L8) found that logout / settings purge
 * only partially cleared client-side residue: OPFS staging plaintext,
 * IndexedDB metadata, Cache Storage shards, and several `mosaic:*`
 * `localStorage` keys all survived. This module centralises an
 * exhaustive wipe so every call site uses the same recipe.
 *
 * Contract:
 *   - Best-effort: each layer is wrapped in try/catch and logged. The
 *     purge ALWAYS attempts every layer even if an earlier one fails —
 *     leaving one layer to fail open silently is worse than partial
 *     completion.
 *   - The IndexedDB delete uses an awaited Promise wrapper so
 *     `success`/`error`/`blocked` are observed and reported (the
 *     historical fire-and-forget `indexedDB.deleteDatabase(name)` could
 *     report success while the delete was still pending or blocked).
 *   - Caller is responsible for any in-memory cache invalidation and
 *     the subsequent logout call. This module only touches durable
 *     client storage.
 */

import { createLogger } from './logger';

const log = createLogger('LocalPurgeAll');

/** Outcome of a single purge step. */
interface StepResult {
  readonly step: string;
  readonly status: 'ok' | 'skipped' | 'failed' | 'blocked';
  readonly detail?: string;
}

export interface ClearAllLocalStateResult {
  readonly steps: ReadonlyArray<StepResult>;
  /** True iff every step that ran completed successfully. */
  readonly allOk: boolean;
}

/**
 * Wipe every client-side persistence layer Mosaic uses.
 *
 * Steps (each independent, all attempted):
 *   1. OPFS — every directory entry whose name starts with `mosaic`
 *      AND `downloads/` (plaintext download staging that lives outside
 *      the `mosaic*` prefix; audit "privacy L4").
 *   2. IndexedDB — every database whose name contains `mosaic`,
 *      awaited via the open-request lifecycle so `blocked` is observed.
 *   3. Cache Storage — every cache whose name starts with `mosaic-`
 *      (audit "privacy L7": `mosaic-bgfetch-cache` was previously left
 *      behind).
 *   4. `localStorage` — every key starting with `mosaic:` or `mosaic-`
 *      (audit "privacy L5/L8/L9": user salt, encrypted album names,
 *      language preference, etc.).
 *   5. `sessionStorage` — full clear. Already cleared on logout but
 *      doing it here too keeps the "forget this device" contract honest
 *      regardless of order vs logout.
 */
export async function clearAllLocalState(): Promise<ClearAllLocalStateResult> {
  const steps: StepResult[] = [];

  steps.push(await purgeOpfs());
  steps.push(await purgeIndexedDb());
  steps.push(await purgeCacheStorage());
  steps.push(purgeLocalStorage());
  steps.push(purgeSessionStorage());

  const allOk = steps.every((s) => s.status === 'ok' || s.status === 'skipped');
  return { steps, allOk };
}

async function purgeOpfs(): Promise<StepResult> {
  if (typeof navigator === 'undefined' || !navigator.storage || !('getDirectory' in navigator.storage)) {
    return { step: 'opfs', status: 'skipped', detail: 'OPFS unavailable' };
  }
  try {
    const root = await navigator.storage.getDirectory();
    const rootWithIterator = root as FileSystemDirectoryHandle & {
      keys(): AsyncIterable<string>;
    };
    const targets: string[] = [];
    for await (const name of rootWithIterator.keys()) {
      if (name.startsWith('mosaic') || name === 'downloads') {
        targets.push(name);
      }
    }
    for (const name of targets) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch (err) {
        log.warn('OPFS entry purge failed', { name, error: err instanceof Error ? err.message : 'unknown' });
      }
    }
    return { step: 'opfs', status: 'ok' };
  } catch (err) {
    return {
      step: 'opfs',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }
}

async function purgeIndexedDb(): Promise<StepResult> {
  if (typeof indexedDB === 'undefined') {
    return { step: 'indexeddb', status: 'skipped', detail: 'IndexedDB unavailable' };
  }
  try {
    const databases = (await indexedDB.databases?.()) ?? [];
    const targets = databases
      .map((d) => d.name)
      .filter((n): n is string => typeof n === 'string' && n.toLowerCase().includes('mosaic'));
    let anyBlocked = false;
    for (const name of targets) {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = (): void => resolve();
          req.onerror = (): void => reject(req.error ?? new Error(`Failed to delete IDB ${name}`));
          req.onblocked = (): void => {
            // Another tab still holds the database open; we can't force
            // close it from here. Record and move on so the user can be
            // told to close other tabs.
            anyBlocked = true;
            resolve();
          };
        });
      } catch (err) {
        log.warn('IDB delete failed', { name, error: err instanceof Error ? err.message : 'unknown' });
      }
    }
    return {
      step: 'indexeddb',
      status: anyBlocked ? 'blocked' : 'ok',
      ...(anyBlocked
        ? { detail: 'One or more databases blocked by other tabs; close them and retry' }
        : {}),
    };
  } catch (err) {
    return {
      step: 'indexeddb',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }
}

async function purgeCacheStorage(): Promise<StepResult> {
  if (typeof caches === 'undefined') {
    return { step: 'cache-storage', status: 'skipped', detail: 'Cache API unavailable' };
  }
  try {
    const names = await caches.keys();
    for (const name of names) {
      if (name.startsWith('mosaic-') || name.startsWith('mosaic:')) {
        try {
          await caches.delete(name);
        } catch (err) {
          log.warn('Cache delete failed', { name, error: err instanceof Error ? err.message : 'unknown' });
        }
      }
    }
    return { step: 'cache-storage', status: 'ok' };
  } catch (err) {
    return {
      step: 'cache-storage',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }
}

function purgeLocalStorage(): StepResult {
  if (typeof localStorage === 'undefined') {
    return { step: 'local-storage', status: 'skipped', detail: 'localStorage unavailable' };
  }
  try {
    const targets: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null) continue;
      if (key.startsWith('mosaic:') || key.startsWith('mosaic-')) {
        targets.push(key);
      }
    }
    for (const key of targets) {
      try {
        localStorage.removeItem(key);
      } catch (err) {
        log.warn('localStorage removeItem failed', { key, error: err instanceof Error ? err.message : 'unknown' });
      }
    }
    return { step: 'local-storage', status: 'ok' };
  } catch (err) {
    return {
      step: 'local-storage',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }
}

function purgeSessionStorage(): StepResult {
  if (typeof sessionStorage === 'undefined') {
    return { step: 'session-storage', status: 'skipped', detail: 'sessionStorage unavailable' };
  }
  try {
    sessionStorage.clear();
    return { step: 'session-storage', status: 'ok' };
  } catch (err) {
    return {
      step: 'session-storage',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }
}
