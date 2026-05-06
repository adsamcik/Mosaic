/**
 * Background-Fetch shard cache lookup.
 *
 * The Service Worker (see `src/service-worker/sw-handlers.ts`) and worker-side
 * Background Fetch integrations store encrypted shard responses in a single
 * named cache (`mosaic-bgfetch-cache`). Foreground shard downloads consult this
 * cache before falling back to the network, so a BG-Fetch completed while the
 * tab was closed gets reused.
 *
 * - Works in both window and worker contexts (Cache API is available in
 *   DedicatedWorker / SharedWorker scopes too).
 * - Pure peek; never writes. Writes happen outside this foreground helper.
 * - All errors are caught and treated as cache misses; correctness must always
 *   fall through to the network.
 */
export const BG_FETCH_CACHE_NAME = 'mosaic-bgfetch-cache';

/** Look up a previously cached shard response. Returns `null` on miss or error. */
export async function lookupCachedShardBytes(
  url: string,
): Promise<Uint8Array | null> {
  try {
    if (typeof caches === 'undefined') {
      return null;
    }

    const cache = await caches.open(BG_FETCH_CACHE_NAME);
    const response = await cache.match(url);
    if (!response?.ok) {
      return null;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Drop a single cached shard response after consumption to bound storage. */
export async function evictCachedShard(url: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') {
      return;
    }

    const cache = await caches.open(BG_FETCH_CACHE_NAME);
    await cache.delete(url);
  } catch {
    // Cache eviction is best-effort; correctness falls back to network fetches.
  }
}
