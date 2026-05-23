/**
 * v1.0.2 storage/eviction hardening — regression tests for
 * `evictStaleCacheEntries` (Item 6 / v102-s34).
 *
 * The SW `activate` handler used to purge only stale *cache names*; it
 * never evicted entries inside the current cache, so the bgfetch cache
 * grew unbounded for long-lived service workers. This test pins down the
 * per-entry TTL behaviour:
 *  - entries stamped older than `maxAgeMs` are deleted
 *  - entries inside the TTL are kept
 *  - entries missing the timestamp header are evicted on first upgrade
 *    (so pre-TTL records do not linger forever)
 *  - per-entry failures are non-fatal
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BG_FETCH_CACHE_NAME,
  BG_FETCH_CACHED_AT_HEADER,
  evictStaleCacheEntries,
  handleBackgroundFetchSuccess,
  type CacheLike,
  type CacheStorageLike,
} from '../sw-handlers';

interface Entry { request: Request; response: Response; }

function makeCache(entries: Entry[]): { cache: CacheLike; storage: CacheStorageLike; deletes: string[] } {
  const map = new Map(entries.map((e) => [e.request.url, e]));
  const deletes: string[] = [];
  const cache: CacheLike = {
    async put(request, response) {
      map.set(request.url, { request, response });
    },
    async keys() {
      return Array.from(map.values()).map((e) => e.request);
    },
    async match(request) {
      return map.get(request.url)?.response;
    },
    async delete(request) {
      const had = map.delete(request.url);
      if (had) deletes.push(request.url);
      return had;
    },
  };
  const storage: CacheStorageLike = {
    async open(name) {
      expect(name).toBe(BG_FETCH_CACHE_NAME);
      return cache;
    },
  };
  return { cache, storage, deletes };
}

function stamped(url: string, cachedAt: number): Entry {
  const headers = new Headers();
  headers.set(BG_FETCH_CACHED_AT_HEADER, String(cachedAt));
  return {
    request: new Request(url),
    response: new Response('x', { status: 200, headers }),
  };
}

function unstamped(url: string): Entry {
  return {
    request: new Request(url),
    response: new Response('x', { status: 200 }),
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('evictStaleCacheEntries (v102-s34)', () => {
  it('deletes entries older than maxAgeMs and keeps fresh ones', async () => {
    const now = 1_000_000_000_000;
    const { storage, deletes } = makeCache([
      stamped('https://x/old', now - 8 * DAY),
      stamped('https://x/fresh', now - 1 * HOUR),
      stamped('https://x/edge-just-stale', now - 7 * DAY - 1),
      stamped('https://x/edge-just-fresh', now - 7 * DAY + 1),
    ]);

    const evicted = await evictStaleCacheEntries({ caches: storage, now });

    expect(evicted).toBe(2);
    expect(deletes.sort()).toEqual([
      'https://x/edge-just-stale',
      'https://x/old',
    ]);
  });

  it('evicts unstamped entries on first upgrade by default', async () => {
    const { storage, deletes } = makeCache([
      unstamped('https://x/legacy-a'),
      unstamped('https://x/legacy-b'),
    ]);

    const evicted = await evictStaleCacheEntries({ caches: storage });

    expect(evicted).toBe(2);
    expect(deletes.sort()).toEqual([
      'https://x/legacy-a',
      'https://x/legacy-b',
    ]);
  });

  it('respects evictUnstamped=false (keeps legacy entries)', async () => {
    const { storage, deletes } = makeCache([
      unstamped('https://x/legacy-a'),
    ]);

    const evicted = await evictStaleCacheEntries({ caches: storage, evictUnstamped: false });

    expect(evicted).toBe(0);
    expect(deletes).toEqual([]);
  });

  it('treats malformed stamps as stale (fail-closed)', async () => {
    const { storage, deletes } = makeCache([
      {
        request: new Request('https://x/garbage'),
        response: new Response('x', {
          status: 200,
          headers: { [BG_FETCH_CACHED_AT_HEADER]: 'not-a-number' },
        }),
      },
      {
        request: new Request('https://x/negative'),
        response: new Response('x', {
          status: 200,
          headers: { [BG_FETCH_CACHED_AT_HEADER]: '-1' },
        }),
      },
    ]);

    const evicted = await evictStaleCacheEntries({ caches: storage });

    expect(evicted).toBe(2);
    expect(deletes.sort()).toEqual(['https://x/garbage', 'https://x/negative']);
  });

  it('returns 0 and does not throw when caches.open rejects', async () => {
    const failingStorage: CacheStorageLike = {
      async open() {
        throw new Error('caches unavailable');
      },
    };
    await expect(evictStaleCacheEntries({ caches: failingStorage })).resolves.toBe(0);
  });

  it('skips eviction when the cache implementation does not expose keys/match/delete', async () => {
    const minimalStorage: CacheStorageLike = {
      async open() {
        return { async put() {} } as CacheLike;
      },
    };
    await expect(evictStaleCacheEntries({ caches: minimalStorage })).resolves.toBe(0);
  });

  it('a single delete failure does not halt the eviction sweep', async () => {
    const now = 2_000_000_000_000;
    const a = stamped('https://x/a', now - 10 * DAY);
    const b = stamped('https://x/b', now - 10 * DAY);
    const c = stamped('https://x/c', now - 10 * DAY);
    const map = new Map([a, b, c].map((e) => [e.request.url, e] as const));
    const cache: CacheLike = {
      async put(request, response) { map.set(request.url, { request, response }); },
      async keys() { return Array.from(map.values()).map((e) => e.request); },
      async match(request) { return map.get(request.url)?.response; },
      async delete(request) {
        if (request.url === 'https://x/b') throw new Error('boom');
        map.delete(request.url);
        return true;
      },
    };
    const storage: CacheStorageLike = { async open() { return cache; } };

    const evicted = await evictStaleCacheEntries({ caches: storage, now });

    expect(evicted).toBe(2); // a and c succeed; b throws but does not abort
    expect(map.has('https://x/a')).toBe(false);
    expect(map.has('https://x/b')).toBe(true);
    expect(map.has('https://x/c')).toBe(false);
  });
});

describe('handleBackgroundFetchSuccess stamps cached-at (v102-s34)', () => {
  it('writes the x-mosaic-cached-at header on every cached response', async () => {
    const map = new Map<string, Response>();
    const cache: CacheLike = {
      async put(request, response) { map.set(request.url, response); },
    };
    const storage: CacheStorageLike = { async open() { return cache; } };
    const messages: unknown[] = [];
    const clients = {
      async matchAll() { return [{ postMessage: (m: unknown) => { messages.push(m); } }]; },
    };
    const registration = {
      id: 'job-1',
      failureReason: '',
      async matchAll() {
        return [
          { request: new Request('https://x/a'), responseReady: Promise.resolve(new Response('x', { status: 200 })) },
        ];
      },
    } as unknown as BackgroundFetchRegistration;

    const before = Date.now();
    await handleBackgroundFetchSuccess({ registration, caches: storage, clients });
    const after = Date.now();

    const stored = map.get('https://x/a')!;
    const stamp = stored.headers.get(BG_FETCH_CACHED_AT_HEADER);
    expect(stamp).not.toBeNull();
    const ts = Number(stamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// Touch vi to keep the linter happy in case of unused-imports.
void vi;
