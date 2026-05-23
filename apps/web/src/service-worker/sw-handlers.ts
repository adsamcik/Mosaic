/**
 * Pure event handlers for the Mosaic Background Fetch service worker.
 *
 * Extracted from `sw.ts` so they can be unit-tested without instantiating
 * a real ServiceWorkerGlobalScope. The SW shell wires these to the actual
 * SW events; tests inject mocked `Cache`, `Clients`, and registrations.
 *
 * SECURITY / ZK INVARIANT
 * -----------------------
 * - Handlers operate on opaque encrypted shard bytes only.
 * - No keys, no plaintext, no decryption.
 * - No opportunistic caching: the SW only stores responses for resources
 *   it was explicitly asked to fetch via `backgroundFetch.fetch(...)`.
 * - Logged messages MUST NOT contain shard contents, URLs, or job-specific
 *   secrets. The job ID is allowed (it's a non-secret correlation handle).
 */

/** Single cache that holds all encrypted bytes fetched via Background Fetch.
 *  Keyed by URL. Encrypted shard URLs are immutable bytes-by-id, so cross-job
 *  reuse is correct and there are no collisions. */
export const BG_FETCH_CACHE_NAME = 'mosaic-bgfetch-cache';

/**
 * Maximum age of a Background Fetch cache entry. Entries older than this
 * are evicted on SW `activate`. 7 days matches the longest-lived realistic
 * download window (large album over slow mobile) while keeping the cache
 * bounded so a never-shutdown SW does not accumulate stale shards forever.
 */
export const BG_FETCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Header name used to stamp each cached response with the time it was
 * stored. Read back by `evictStaleCacheEntries` to enforce TTL eviction.
 * Lives only inside the SW cache; never sent to the server.
 */
export const BG_FETCH_CACHED_AT_HEADER = 'x-mosaic-cached-at';

export interface BgFetchSuccessMessage {
  readonly type: 'mosaic.bgfetch.success';
  readonly jobId: string;
  readonly urls: readonly string[];
}

export interface BgFetchFailMessage {
  readonly type: 'mosaic.bgfetch.fail';
  readonly jobId: string;
  /** Stable, low-cardinality reason. Mirrors `BackgroundFetchRegistration.failureReason`
   *  plus `'aborted'` for the abort event. */
  readonly reason: string;
}

export type BgFetchClientMessage = BgFetchSuccessMessage | BgFetchFailMessage;

/** Minimal shape we need from the SW Clients interface (testable). */
export interface ClientLike {
  postMessage(message: unknown): void;
}
export interface ClientsLike {
  matchAll(options?: { includeUncontrolled?: boolean; type?: string }): Promise<readonly ClientLike[]>;
}

/** Minimal shape of `caches` we use (testable). */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}
export interface CacheLike {
  put(request: Request, response: Response): Promise<void>;
  keys?(): Promise<readonly Request[]>;
  match?(request: Request): Promise<Response | undefined>;
  delete?(request: Request): Promise<boolean>;
}

export interface SuccessHandlerInput {
  readonly registration: BackgroundFetchRegistration;
  readonly caches: CacheStorageLike;
  readonly clients: ClientsLike;
}

export interface FailHandlerInput {
  readonly registration: BackgroundFetchRegistration;
  readonly clients: ClientsLike;
  /** 'fail' for backgroundfetchfail, 'abort' for backgroundfetchabort. */
  readonly kind: 'fail' | 'abort';
}

/**
 * Handle a successful Background Fetch.
 *
 * - Iterates all matched records.
 * - Stores each (request, response) pair into the bg-fetch cache.
 * - Posts a success message to all clients (uncontrolled + controlled).
 *
 * Failure to cache a single record is non-fatal: we still notify clients
 * with the URLs we did persist so they can retry the rest via foreground.
 */
export async function handleBackgroundFetchSuccess(input: SuccessHandlerInput): Promise<void> {
  const { registration, caches, clients } = input;
  const records = await registration.matchAll();
  const cache = await caches.open(BG_FETCH_CACHE_NAME);

  const cachedUrls: string[] = [];
  for (const record of records) {
    try {
      const response = await record.responseReady;
      // Only store 2xx responses. Non-2xx means the server returned an error
      // for that shard; the foreground retry path will surface it properly.
      if (response.ok) {
        const stampedResponse = stampCachedAt(response.clone(), Date.now());
        await cache.put(record.request, stampedResponse);
        cachedUrls.push(record.request.url);
      }
    } catch {
      // Swallow per-record failures; absence triggers foreground fallback.
    }
  }

  const message: BgFetchSuccessMessage = {
    type: 'mosaic.bgfetch.success',
    jobId: registration.id,
    urls: cachedUrls,
  };
  await broadcast(clients, message);
}

/** Handle backgroundfetchfail / backgroundfetchabort: notify clients only. */
export async function handleBackgroundFetchFail(input: FailHandlerInput): Promise<void> {
  const { registration, clients, kind } = input;
  const reason = kind === 'abort' ? 'aborted' : (registration.failureReason || 'unknown');
  const message: BgFetchFailMessage = {
    type: 'mosaic.bgfetch.fail',
    jobId: registration.id,
    reason,
  };
  await broadcast(clients, message);
}

async function broadcast(clients: ClientsLike, message: BgFetchClientMessage): Promise<void> {
  const matched = await clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of matched) {
    try {
      client.postMessage(message);
    } catch {
      // postMessage to a closed/closing client is non-fatal.
    }
  }
}

/**
 * Re-stamp a response with an `x-mosaic-cached-at` header recording the
 * time it was written into the cache. Response bodies are streams that can
 * only be consumed once, so we reconstruct a fresh Response from the
 * cloned source while preserving status, statusText, and existing headers.
 */
function stampCachedAt(response: Response, now: number): Response {
  const headers = new Headers(response.headers);
  headers.set(BG_FETCH_CACHED_AT_HEADER, String(now));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Evict cache entries older than `maxAgeMs`.
 *
 * Called from the SW `activate` handler. Without this, the bgfetch cache
 * grows unbounded for users who download many albums over time: the
 * previous SW only purged stale *cache names*, never entries inside the
 * current cache.
 *
 * Entries are evicted when:
 *  - they carry an `x-mosaic-cached-at` header older than `maxAgeMs`, OR
 *  - the header is missing/malformed AND `evictUnstamped` is `true`
 *    (used to garbage-collect pre-TTL entries on first upgrade).
 *
 * The function logs nothing and never throws — failures to delete one
 * entry must not stop the activate handler from completing.
 *
 * @returns The number of entries evicted.
 */
export async function evictStaleCacheEntries(input: {
  readonly caches: CacheStorageLike;
  readonly cacheName?: string;
  readonly maxAgeMs?: number;
  readonly now?: number;
  readonly evictUnstamped?: boolean;
}): Promise<number> {
  const cacheName = input.cacheName ?? BG_FETCH_CACHE_NAME;
  const maxAgeMs = input.maxAgeMs ?? BG_FETCH_MAX_AGE_MS;
  const now = input.now ?? Date.now();
  const evictUnstamped = input.evictUnstamped ?? true;

  let cache: CacheLike;
  try {
    cache = await input.caches.open(cacheName);
  } catch {
    return 0;
  }

  if (typeof cache.keys !== 'function'
    || typeof cache.match !== 'function'
    || typeof cache.delete !== 'function') {
    return 0;
  }

  let requests: readonly Request[];
  try {
    requests = await cache.keys();
  } catch {
    return 0;
  }

  let evicted = 0;
  for (const request of requests) {
    let stale = false;
    try {
      const response = await cache.match(request);
      if (!response) {
        continue;
      }
      const stamp = response.headers.get(BG_FETCH_CACHED_AT_HEADER);
      if (stamp === null) {
        stale = evictUnstamped;
      } else {
        const ts = Number(stamp);
        if (!Number.isFinite(ts) || ts <= 0) {
          stale = evictUnstamped;
        } else {
          stale = now - ts > maxAgeMs;
        }
      }
    } catch {
      // If we cannot inspect the entry, leave it alone — the next
      // activate pass will retry.
      continue;
    }

    if (!stale) {
      continue;
    }

    try {
      if (await cache.delete(request)) {
        evicted += 1;
      }
    } catch {
      // Per-entry delete failure is non-fatal.
    }
  }

  return evicted;
}