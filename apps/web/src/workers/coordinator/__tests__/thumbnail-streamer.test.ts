import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createThumbnailStreamer, type ThumbnailManifestEntry, type ThumbnailStreamerDeps } from '../thumbnail-streamer';

interface UrlRegistry {
  created: string[];
  revoked: string[];
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

function makeUrlRegistry(): UrlRegistry {
  const created: string[] = [];
  const revoked: string[] = [];
  let nextId = 0;
  return {
    created,
    revoked,
    createObjectURL: (_blob: Blob): string => {
      nextId += 1;
      const url = `blob:test#${nextId}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string): void => { revoked.push(url); },
  };
}

function asyncIterable<T>(items: ReadonlyArray<T>, opts?: { delayMs?: number }): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      for (const it of items) {
        if (opts?.delayMs && opts.delayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        yield it;
      }
    },
  };
}

function makeEntry(idSuffix: string): ThumbnailManifestEntry {
  return {
    photoId: `photo-${idSuffix}-aaaaaaaaaaaaaaaa`,
    epochId: '1',
    thumbShardId: `shard-${idSuffix}`,
  };
}

function makeDeps(overrides: Partial<ThumbnailStreamerDeps>, urls: UrlRegistry): ThumbnailStreamerDeps {
  return {
    fetchShard: async (_id, _signal) => new Uint8Array([1, 2, 3]),
    resolveThumbKey: async () => new Uint8Array(32),
    decryptShard: async (bytes) => bytes,
    resolveJobThumbnails: () => asyncIterable([]),
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
    warn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('thumbnail-streamer', () => {
  it('emits decrypted thumbnails in manifest order for one job', async () => {
    const urls = makeUrlRegistry();
    const entries = [makeEntry('1'), makeEntry('2'), makeEntry('3')];
    const streamer = createThumbnailStreamer(makeDeps({
      resolveJobThumbnails: () => asyncIterable(entries),
    }, urls));
    const received: Array<{ photoId: string; url: string }> = [];
    const unsub = streamer.subscribe('job-A', (photoId, url) => { received.push({ photoId, url }); });
    // Wait for loop to drain.
    await new Promise((r) => setTimeout(r, 30));
    expect(received.map((r) => r.photoId)).toEqual(entries.map((e) => e.photoId));
    expect(urls.created.length).toBe(3);
    unsub();
    // Allow stop's microtask cleanup to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(urls.revoked.length).toBe(3);
  });

  it('stop during fetch revokes blob URLs and halts iteration', async () => {
    const urls = makeUrlRegistry();
    const fetchSpy = vi.fn(async (_id: string, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 50);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return new Uint8Array([9]);
    });
    const entries = [makeEntry('1'), makeEntry('2'), makeEntry('3'), makeEntry('4')];
    const streamer = createThumbnailStreamer(makeDeps({
      fetchShard: fetchSpy,
      resolveJobThumbnails: () => asyncIterable(entries),
      perJobConcurrency: 2,
    }, urls));
    const received: string[] = [];
    streamer.subscribe('job-S', (photoId) => { received.push(photoId); });
    // Stop almost immediately — before fetches complete.
    await new Promise((r) => setTimeout(r, 5));
    streamer.stop('job-S');
    await new Promise((r) => setTimeout(r, 80));
    // Created may be 0 or small; revoked must equal created.
    expect(urls.revoked.length).toBe(urls.created.length);
    // Subsequent yields after stop should NOT produce new URLs.
    const before = urls.created.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(urls.created.length).toBe(before);
  });

  it('clear revokes blob URLs across all jobs', async () => {
    const urls = makeUrlRegistry();
    const streamer = createThumbnailStreamer(makeDeps({
      resolveJobThumbnails: (jobId) => asyncIterable([makeEntry(`${jobId}-x`), makeEntry(`${jobId}-y`)]),
    }, urls));
    streamer.subscribe('job-1', () => undefined);
    streamer.subscribe('job-2', () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(urls.created.length).toBe(4);
    streamer.clear();
    await new Promise((r) => setTimeout(r, 5));
    expect(urls.revoked.length).toBe(4);
  });

  it('respects per-job concurrency limit', async () => {
    const urls = makeUrlRegistry();
    let inflight = 0;
    let peak = 0;
    const fetchSpy = vi.fn(async (_id: string, _signal: AbortSignal) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      return new Uint8Array([0]);
    });
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(String(i)));
    const streamer = createThumbnailStreamer(makeDeps({
      fetchShard: fetchSpy,
      resolveJobThumbnails: () => asyncIterable(entries),
      perJobConcurrency: 2,
      globalConcurrency: 8,
    }, urls));
    streamer.subscribe('job-C', () => undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(peak).toBeLessThanOrEqual(2);
    expect(urls.created.length).toBe(10);
    streamer.stop('job-C');
  });

  it('respects global concurrency cap across jobs', async () => {
    const urls = makeUrlRegistry();
    let inflight = 0;
    let peak = 0;
    const fetchSpy = vi.fn(async (_id: string, _signal: AbortSignal) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight -= 1;
      return new Uint8Array([0]);
    });
    const entries = (jobId: string): ThumbnailManifestEntry[] =>
      Array.from({ length: 6 }, (_, i) => makeEntry(`${jobId}-${i}`));
    const streamer = createThumbnailStreamer(makeDeps({
      fetchShard: fetchSpy,
      resolveJobThumbnails: (jobId) => asyncIterable(entries(jobId)),
      perJobConcurrency: 4,
      globalConcurrency: 3,
    }, urls));
    streamer.subscribe('j-A', () => undefined);
    streamer.subscribe('j-B', () => undefined);
    streamer.subscribe('j-C', () => undefined);
    await new Promise((r) => setTimeout(r, 250));
    expect(peak).toBeLessThanOrEqual(3);
    streamer.clear();
  });

  it('skips entries whose fetch fails without poisoning the loop', async () => {
    const urls = makeUrlRegistry();
    const warnSpy = vi.fn();
    const fetchSpy = vi.fn(async (id: string) => {
      if (id === 'shard-2') throw new Error('network down');
      return new Uint8Array([1]);
    });
    const entries = [makeEntry('1'), makeEntry('2'), makeEntry('3')];
    const streamer = createThumbnailStreamer(makeDeps({
      fetchShard: fetchSpy,
      resolveJobThumbnails: () => asyncIterable(entries),
      warn: warnSpy,
    }, urls));
    const received: string[] = [];
    streamer.subscribe('job-F', (photoId) => { received.push(photoId); });
    await new Promise((r) => setTimeout(r, 40));
    expect(received).toHaveLength(2);
    expect(received).not.toContain(entries[1]!.photoId);
    expect(warnSpy).toHaveBeenCalled();
    streamer.stop('job-F');
  });

  it('skips entries whose decrypt fails without poisoning the loop', async () => {
    const urls = makeUrlRegistry();
    const warnSpy = vi.fn();
    const decryptSpy = vi.fn(async (bytes: Uint8Array) => {
      if (bytes[0] === 0xFF) throw new Error('bad mac');
      return bytes;
    });
    const fetchSpy = vi.fn(async (id: string) =>
      id === 'shard-2' ? new Uint8Array([0xFF]) : new Uint8Array([0x01]),
    );
    const entries = [makeEntry('1'), makeEntry('2'), makeEntry('3')];
    const streamer = createThumbnailStreamer(makeDeps({
      fetchShard: fetchSpy,
      decryptShard: decryptSpy,
      resolveJobThumbnails: () => asyncIterable(entries),
      warn: warnSpy,
    }, urls));
    const received: string[] = [];
    streamer.subscribe('job-D', (photoId) => { received.push(photoId); });
    await new Promise((r) => setTimeout(r, 40));
    expect(received).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    streamer.stop('job-D');
  });

  it('multiple subscribers share one loop and unsubscribe ref-counts cleanly', async () => {
    const urls = makeUrlRegistry();
    const entries = [makeEntry('1'), makeEntry('2')];
    const fetchSpy = vi.fn(async () => new Uint8Array([1]));
    const streamer = createThumbnailStreamer(makeDeps({
      fetchShard: fetchSpy,
      resolveJobThumbnails: () => asyncIterable(entries),
    }, urls));
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = streamer.subscribe('job-M', (id) => a.push(id));
    const unsubB = streamer.subscribe('job-M', (id) => b.push(id));
    await new Promise((r) => setTimeout(r, 30));
    // Loop runs once; both subscribers see all entries.
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    unsubA();
    unsubB();
    await new Promise((r) => setTimeout(r, 5));
    expect(urls.revoked.length).toBe(urls.created.length);
  });
});
