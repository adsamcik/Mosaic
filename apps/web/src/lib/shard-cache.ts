/**
 * Background-Fetch shard cache lookup.
 *
 * Encrypted shard responses may be written to `mosaic-bgfetch-cache` by a
 * Service Worker or worker-side Background Fetch integration. Foreground
 * shard downloads consult the cache before falling back to the network.
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
