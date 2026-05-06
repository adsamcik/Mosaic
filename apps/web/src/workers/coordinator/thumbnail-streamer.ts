/**
 * Thumbnail streamer — orchestrates per-job low-priority fetch + decrypt of
 * tier-1 thumbnail shards into Blob URLs for in-app preview ONLY.
 *
 * **Lifecycle / memory contract**
 *   1. `subscribe(jobId, cb)` increments a per-job refcount and (if first)
 *      starts an async loop iterating `resolveJobThumbnails(jobId)`.
 *   2. Each thumbnail: fetch encrypted shard → resolve key → decrypt →
 *      `URL.createObjectURL(new Blob([plaintext]))` → emit to all subscribers.
 *   3. `stop(jobId)` halts the loop and revokes EVERY blob URL minted for
 *      that job. Idempotent.
 *   4. `clear()` revokes EVERY blob URL across all jobs (emergency cleanup).
 *   5. The unsubscribe handle returned by `subscribe` decrements the refcount
 *      and triggers `stop(jobId)` when it reaches zero.
 *
 * **ZK invariants**
 *   - Encrypted shard bytes never leave the worker.
 *   - Decryption produces plaintext kept only inside an immediately-wrapped
 *     `Blob`; the raw `Uint8Array` reference is not retained beyond the
 *     emit call (Blob copies the buffer).
 *   - photoIds are NOT logged in raw form (see `shortenForLog`).
 *   - Failures (network / decrypt) skip the offending entry and continue —
 *     a single bad thumbnail must not poison the loop.
 *
 * **Concurrency**
 *   - Per-job inflight is bounded (default 2) so thumbnail traffic does NOT
 *     compete with the main download.
 *   - A global semaphore (default 4) caps cross-job thumbnail concurrency.
 *
 * **NOT exported**
 *   The streamer is wired ONLY to the in-app preview subscription path.
 *   It MUST NOT be referenced from any export code path
 *   (zip-finalizer, per-file-finalizer, fsAccessDirectory). Verified by
 *   absence of imports in those modules — see acceptance criteria.
 */

const DEFAULT_PER_JOB_CONCURRENCY = 2;
const DEFAULT_GLOBAL_CONCURRENCY = 4;

export interface ThumbnailManifestEntry {
  readonly photoId: string;
  readonly epochId: string;
  readonly thumbShardId: string;
  /** Optional job-bound shard fetcher. Used to avoid cross-job source races. */
  readonly fetchShard?: (shardId: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Optional job-bound key resolver. Used to avoid cross-job album/source races. */
  readonly resolveThumbKey?: (photoId: string, epochId: string) => Promise<Uint8Array>;
}

export type ThumbnailEmit = (photoId: string, blobUrl: string) => void;

export interface ThumbnailStreamerDeps {
  readonly fetchShard: (shardId: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly resolveThumbKey: (photoId: string, epochId: string) => Promise<Uint8Array>;
  readonly decryptShard: (bytes: Uint8Array, key: Uint8Array) => Promise<Uint8Array>;
  readonly resolveJobThumbnails: (jobId: string) => AsyncIterable<ThumbnailManifestEntry>;
  /** Optional dev-mode warning sink (defaults to console.warn). ZK-safe strings only. */
  readonly warn?: (message: string, context?: Record<string, unknown>) => void;
  /** Optional perJob concurrency override (default 2). */
  readonly perJobConcurrency?: number;
  /** Optional global concurrency override (default 4). */
  readonly globalConcurrency?: number;
  /** Injection seam for tests / non-DOM environments. Defaults to globalThis URL. */
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
}

export interface ThumbnailStreamer {
  /** Subscribe to thumbnail bytes for a job. Returns unsubscribe. Idempotent on duplicate callbacks. */
  subscribe(jobId: string, onThumbnail: ThumbnailEmit): () => void;
  /** Stop fetching for a job and revoke all of its blob URLs. Idempotent. */
  stop(jobId: string): void;
  /** Hard reset — revokes ALL blob URLs across every job. */
  clear(): void;
}

interface JobState {
  readonly jobId: string;
  readonly subscribers: Set<ThumbnailEmit>;
  readonly abort: AbortController;
  readonly blobUrls: Set<string>;
  /** Count of created object URLs for leak diagnostics. */
  createdCount: number;
  revokedCount: number;
  loopPromise: Promise<void> | null;
}

/** Simple counting semaphore (FIFO). */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.permits -= 1;
  }
  release(): void {
    this.permits += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function shortenForLog(photoId: string): string {
  if (photoId.length <= 10) return photoId;
  return `${photoId.slice(0, 4)}…${photoId.slice(-4)}`;
}

function defaultCreateObjectURL(blob: Blob): string {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('URL.createObjectURL is unavailable in this environment');
  }
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectURL(url: string): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

export function createThumbnailStreamer(deps: ThumbnailStreamerDeps): ThumbnailStreamer {
  const perJobConcurrency = Math.max(1, deps.perJobConcurrency ?? DEFAULT_PER_JOB_CONCURRENCY);
  const globalConcurrency = Math.max(1, deps.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY);
  const globalSem = new Semaphore(globalConcurrency);
  const warn = deps.warn ?? ((m: string, ctx?: Record<string, unknown>): void => {
    // eslint-disable-next-line no-console
    console.warn(`[thumbnail-streamer] ${m}`, ctx ?? {});
  });
  const createUrl = deps.createObjectURL ?? defaultCreateObjectURL;
  const revokeUrl = deps.revokeObjectURL ?? defaultRevokeObjectURL;
  const jobs = new Map<string, JobState>();

  function getOrCreate(jobId: string): JobState {
    let state = jobs.get(jobId);
    if (state) return state;
    state = {
      jobId,
      subscribers: new Set<ThumbnailEmit>(),
      abort: new AbortController(),
      blobUrls: new Set<string>(),
      createdCount: 0,
      revokedCount: 0,
      loopPromise: null,
    };
    jobs.set(jobId, state);
    return state;
  }

  async function processOne(state: JobState, entry: ThumbnailManifestEntry, perJobSem: Semaphore): Promise<void> {
    if (state.abort.signal.aborted) return;
    await perJobSem.acquire();
    if (state.abort.signal.aborted) {
      perJobSem.release();
      return;
    }
    await globalSem.acquire();
    if (state.abort.signal.aborted) {
      globalSem.release();
      perJobSem.release();
      return;
    }
    try {
      let encrypted: Uint8Array;
      try {
        const fetchShard = entry.fetchShard ?? deps.fetchShard;
        encrypted = await fetchShard(entry.thumbShardId, state.abort.signal);
      } catch (err) {
        if (state.abort.signal.aborted) return;
        warn('thumbnail fetch failed; skipping', { photoId: shortenForLog(entry.photoId), errName: errorName(err) });
        return;
      }
      if (state.abort.signal.aborted) return;
      let key: Uint8Array;
      try {
        const resolveThumbKey = entry.resolveThumbKey ?? deps.resolveThumbKey;
        key = await resolveThumbKey(entry.photoId, entry.epochId);
      } catch (err) {
        if (state.abort.signal.aborted) return;
        warn('thumbnail key resolve failed; skipping', { photoId: shortenForLog(entry.photoId), errName: errorName(err) });
        return;
      }
      if (state.abort.signal.aborted) return;
      let plaintext: Uint8Array;
      try {
        plaintext = await deps.decryptShard(encrypted, key);
      } catch (err) {
        if (state.abort.signal.aborted) return;
        warn('thumbnail decrypt failed; skipping', { photoId: shortenForLog(entry.photoId), errName: errorName(err) });
        return;
      }
      if (state.abort.signal.aborted) return;
      const blob = new Blob([new Uint8Array(plaintext)]);
      const url = createUrl(blob);
      state.blobUrls.add(url);
      state.createdCount += 1;
      // Snapshot subscribers so a re-entrant unsubscribe inside a callback
      // doesn't disturb iteration.
      const callbacks = [...state.subscribers];
      for (const cb of callbacks) {
        try {
          cb(entry.photoId, url);
        } catch (err) {
          warn('subscriber threw; continuing', { errName: errorName(err) });
        }
      }
    } finally {
      globalSem.release();
      perJobSem.release();
    }
  }

  async function runLoop(state: JobState): Promise<void> {
    const perJobSem = new Semaphore(perJobConcurrency);
    const inflight: Promise<void>[] = [];
    try {
      const iter = deps.resolveJobThumbnails(state.jobId);
      for await (const entry of iter) {
        if (state.abort.signal.aborted) break;
        const p = processOne(state, entry, perJobSem).catch((err) => {
          // Defensive: processOne handles its own errors; this is for truly
          // unexpected throws so the loop is never poisoned.
          warn('processOne threw unexpectedly', { errName: errorName(err) });
        });
        inflight.push(p);
        // Cap pending promises to perJobConcurrency * 2 to avoid unbounded
        // queueing if the iterable yields faster than we can drain.
        if (inflight.length >= perJobConcurrency * 2) {
          await Promise.race(inflight);
          // Drop settled.
          for (let i = inflight.length - 1; i >= 0; i -= 1) {
            const candidate = inflight[i];
            if (candidate && (await isSettled(candidate))) inflight.splice(i, 1);
          }
        }
      }
    } catch (err) {
      if (!state.abort.signal.aborted) {
        warn('thumbnail iterator threw', { errName: errorName(err) });
      }
    } finally {
      await Promise.allSettled(inflight);
    }
  }

  function revokeAllForJob(state: JobState): void {
    for (const url of state.blobUrls) {
      try {
        revokeUrl(url);
      } catch {
        // best-effort
      }
      state.revokedCount += 1;
    }
    state.blobUrls.clear();
    if (state.createdCount !== state.revokedCount) {
      warn('blob URL leak detected on job stop', {
        jobId: shortenForLog(state.jobId),
        created: state.createdCount,
        revoked: state.revokedCount,
      });
    }
  }

  return {
    subscribe(jobId: string, onThumbnail: ThumbnailEmit): () => void {
      const state = getOrCreate(jobId);
      state.subscribers.add(onThumbnail);
      if (state.loopPromise === null) {
        state.loopPromise = runLoop(state);
      }
      let unsubscribed = false;
      return (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        state.subscribers.delete(onThumbnail);
        if (state.subscribers.size === 0) {
          // Last subscriber leaving — tear down to free memory.
          // (clients can re-subscribe later; the loop will restart from the top.)
          this.stop(jobId);
        }
      };
    },
    stop(jobId: string): void {
      const state = jobs.get(jobId);
      if (!state) return;
      state.abort.abort();
      state.subscribers.clear();
      revokeAllForJob(state);
      // Wait for loop to settle in the background — we don't await here so
      // stop is sync (UI-friendly); the loop honors abort and will exit.
      void (async (): Promise<void> => {
        try {
          await state.loopPromise;
        } catch {
          // already logged
        } finally {
          // Late-arriving URLs (created after abort but before loop saw it)
          // are still added to state.blobUrls in processOne — sweep again.
          if (state.blobUrls.size > 0) {
            for (const url of state.blobUrls) {
              try { revokeUrl(url); } catch { /* noop */ }
              state.revokedCount += 1;
            }
            state.blobUrls.clear();
          }
          jobs.delete(jobId);
        }
      })();
    },
    clear(): void {
      const ids = [...jobs.keys()];
      for (const id of ids) {
        this.stop(id);
      }
    },
  };
}

async function isSettled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), Promise.resolve(false)]);
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return 'Unknown';
}
