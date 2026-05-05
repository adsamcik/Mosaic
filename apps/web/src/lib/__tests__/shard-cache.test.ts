import { afterEach, describe, expect, it, vi } from 'vitest';
import { BG_FETCH_CACHE_NAME, evictCachedShard, lookupCachedShardBytes } from '../shard-cache';

interface FakeCache {
  match: (url: string) => Promise<Response | undefined>;
  delete: (url: string) => Promise<boolean>;
}
interface FakeCacheStorage {
  open: (name: string) => Promise<FakeCache>;
}

const originalCaches = (globalThis as { caches?: FakeCacheStorage }).caches;

afterEach(() => {
  if (originalCaches === undefined) {
    delete (globalThis as { caches?: FakeCacheStorage }).caches;
  } else {
    (globalThis as { caches?: FakeCacheStorage }).caches = originalCaches;
  }
});

function installCaches(map: Map<string, Response>): { deletes: string[] } {
  const deletes: string[] = [];
  const cache: FakeCache = {
    match: async (url: string) => map.get(url),
    delete: async (url: string) => { deletes.push(url); return map.delete(url); },
  };
  const storage: FakeCacheStorage = {
    open: async (name) => {
      expect(name).toBe(BG_FETCH_CACHE_NAME);
      return cache;
    },
  };
  (globalThis as { caches?: FakeCacheStorage }).caches = storage;
  return { deletes };
}

describe('lookupCachedShardBytes', () => {
  it('returns null when caches API is missing', async () => {
    delete (globalThis as { caches?: FakeCacheStorage }).caches;
    expect(await lookupCachedShardBytes('https://x/api/shards/a')).toBeNull();
  });

  it('returns bytes on cache hit', async () => {
    const map = new Map<string, Response>([
      ['https://x/api/shards/a', new Response(new Uint8Array([1, 2, 3]))],
    ]);
    installCaches(map);
    const out = await lookupCachedShardBytes('https://x/api/shards/a');
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([1, 2, 3]);
  });

  it('returns null on cache miss', async () => {
    installCaches(new Map());
    expect(await lookupCachedShardBytes('https://x/api/shards/missing')).toBeNull();
  });

  it('returns null when cache.open throws (graceful fallback)', async () => {
    (globalThis as { caches?: FakeCacheStorage }).caches = {
      open: async () => { throw new Error('storage gone'); },
    };
    expect(await lookupCachedShardBytes('u')).toBeNull();
  });

  it('returns null for non-OK cached responses', async () => {
    const map = new Map<string, Response>([
      ['u', new Response('x', { status: 500 })],
    ]);
    installCaches(map);
    expect(await lookupCachedShardBytes('u')).toBeNull();
  });
});

describe('evictCachedShard', () => {
  it('deletes the URL from the cache', async () => {
    const map = new Map<string, Response>([['u', new Response('x')]]);
    const { deletes } = installCaches(map);
    await evictCachedShard('u');
    expect(deletes).toEqual(['u']);
  });

  it('does not throw when caches missing', async () => {
    delete (globalThis as { caches?: FakeCacheStorage }).caches;
    await expect(evictCachedShard('u')).resolves.toBeUndefined();
  });

  it('swallows errors', async () => {
    (globalThis as { caches?: FakeCacheStorage }).caches = {
      open: async () => { throw new Error('boom'); },
    };
    await expect(evictCachedShard('u')).resolves.toBeUndefined();
  });

  it('logs a no-op silently when cache.delete throws', async () => {
    const cache: FakeCache = {
      match: async () => undefined,
      delete: async () => { throw new Error('lost'); },
    };
    (globalThis as { caches?: FakeCacheStorage }).caches = { open: async () => cache };
    await expect(evictCachedShard('u')).resolves.toBeUndefined();
  });
});

// Prevent unused-import warnings for vi.
void vi;