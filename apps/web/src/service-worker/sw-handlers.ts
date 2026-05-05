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
        await cache.put(record.request, response.clone());
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