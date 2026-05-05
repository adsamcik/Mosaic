import { describe, expect, it, vi } from 'vitest';
import {
  BG_FETCH_CACHE_NAME,
  handleBackgroundFetchFail,
  handleBackgroundFetchSuccess,
  type CacheLike,
  type CacheStorageLike,
  type ClientLike,
  type ClientsLike,
} from '../sw-handlers';

function makeCache(): { cache: CacheLike; puts: Array<{ url: string; ok: boolean }>; storage: CacheStorageLike } {
  const puts: Array<{ url: string; ok: boolean }> = [];
  const cache: CacheLike = {
    async put(request, response) {
      puts.push({ url: request.url, ok: response.ok });
    },
  };
  const storage: CacheStorageLike = {
    async open(name) {
      expect(name).toBe(BG_FETCH_CACHE_NAME);
      return cache;
    },
  };
  return { cache, puts, storage };
}

function makeClients(): { clients: ClientsLike; messages: unknown[] } {
  const messages: unknown[] = [];
  const client: ClientLike = {
    postMessage: (m) => { messages.push(m); },
  };
  const clients: ClientsLike = {
    async matchAll() { return [client]; },
  };
  return { clients, messages };
}

function makeRegistration(records: Array<{ url: string; status: number }>, opts?: {
  id?: string;
  failureReason?: BackgroundFetchRegistration['failureReason'];
}): BackgroundFetchRegistration {
  const recs = records.map((r) => ({
    request: new Request(r.url),
    responseReady: Promise.resolve(new Response('x', { status: r.status })),
  }));
  return {
    id: opts?.id ?? 'job-1',
    uploadTotal: 0,
    uploaded: 0,
    downloadTotal: 0,
    downloaded: 0,
    result: 'success',
    failureReason: opts?.failureReason ?? '',
    recordsAvailable: true,
    abort: vi.fn().mockResolvedValue(true),
    match: vi.fn(),
    matchAll: vi.fn().mockResolvedValue(recs),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
  } as unknown as BackgroundFetchRegistration;
}

describe('handleBackgroundFetchSuccess', () => {
  it('caches all OK records and broadcasts success with their URLs', async () => {
    const { storage, puts } = makeCache();
    const { clients, messages } = makeClients();
    const registration = makeRegistration([
      { url: 'https://x/api/shards/a', status: 200 },
      { url: 'https://x/api/shards/b', status: 200 },
    ]);

    await handleBackgroundFetchSuccess({ registration, caches: storage, clients });

    expect(puts.map((p) => p.url).sort()).toEqual([
      'https://x/api/shards/a',
      'https://x/api/shards/b',
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: 'mosaic.bgfetch.success',
      jobId: 'job-1',
      urls: ['https://x/api/shards/a', 'https://x/api/shards/b'],
    });
  });

  it('skips non-2xx responses but still broadcasts the partial set', async () => {
    const { storage, puts } = makeCache();
    const { clients, messages } = makeClients();
    const registration = makeRegistration([
      { url: 'https://x/api/shards/a', status: 200 },
      { url: 'https://x/api/shards/b', status: 404 },
    ]);

    await handleBackgroundFetchSuccess({ registration, caches: storage, clients });

    expect(puts.map((p) => p.url)).toEqual(['https://x/api/shards/a']);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { urls: string[] }).urls).toEqual(['https://x/api/shards/a']);
  });

  it('survives a failing cache.put for a single record', async () => {
    const failingStorage: CacheStorageLike = {
      async open() {
        return {
          async put(request) {
            if (request.url.endsWith('/b')) throw new Error('quota');
          },
        };
      },
    };
    const { clients, messages } = makeClients();
    const registration = makeRegistration([
      { url: 'https://x/api/shards/a', status: 200 },
      { url: 'https://x/api/shards/b', status: 200 },
    ]);

    await handleBackgroundFetchSuccess({ registration, caches: failingStorage, clients });

    expect(messages).toHaveLength(1);
    expect((messages[0] as { urls: string[] }).urls).toEqual(['https://x/api/shards/a']);
  });
});

describe('handleBackgroundFetchFail', () => {
  it('broadcasts failureReason on fail', async () => {
    const { clients, messages } = makeClients();
    const registration = makeRegistration([], { id: 'job-9', failureReason: 'fetch-error' });
    await handleBackgroundFetchFail({ registration, clients, kind: 'fail' });
    expect(messages[0]).toEqual({
      type: 'mosaic.bgfetch.fail',
      jobId: 'job-9',
      reason: 'fetch-error',
    });
  });

  it('reports "aborted" on abort kind regardless of failureReason', async () => {
    const { clients, messages } = makeClients();
    const registration = makeRegistration([], { id: 'job-9', failureReason: '' });
    await handleBackgroundFetchFail({ registration, clients, kind: 'abort' });
    expect(messages[0]).toEqual({
      type: 'mosaic.bgfetch.fail',
      jobId: 'job-9',
      reason: 'aborted',
    });
  });
});