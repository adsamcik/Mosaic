import { describe, expect, it, vi } from 'vitest';
import {
  BG_FETCH_PHOTO_COUNT_THRESHOLD,
  maybeStartBackgroundFetch,
  type BgFetchStarter,
} from '../background-fetch-launcher';

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: vi.fn(), scope: 'test',
  }),
}));

function makeStarter(supported: boolean, opts?: { fail?: boolean }): {
  starter: BgFetchStarter;
  start: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn().mockImplementation(async (_urls: string[], options: { id: string }) => {
    if (opts?.fail) throw new Error('boom');
    return { id: options.id, abort: vi.fn().mockResolvedValue(true) };
  });
  return {
    starter: { support: { supported }, start },
    start,
  };
}

describe('maybeStartBackgroundFetch', () => {
  it('returns unsupported on browsers without BG-Fetch (Firefox/Safari)', async () => {
    const { starter, start } = makeStarter(false);
    const r = await maybeStartBackgroundFetch(starter, {
      jobId: 'j', title: 't', shardIds: ['a'], photoCount: 100,
    });
    expect(r.kind).toBe('unsupported');
    expect(start).not.toHaveBeenCalled();
  });

  it('skips for jobs below the photo-count threshold', async () => {
    const { starter, start } = makeStarter(true);
    const r = await maybeStartBackgroundFetch(starter, {
      jobId: 'j', title: 't', shardIds: ['a'], photoCount: BG_FETCH_PHOTO_COUNT_THRESHOLD - 1,
    });
    expect(r.kind).toBe('too-small');
    expect(start).not.toHaveBeenCalled();
  });

  it('skips when there are no shards', async () => {
    const { starter } = makeStarter(true);
    const r = await maybeStartBackgroundFetch(starter, {
      jobId: 'j', title: 't', shardIds: [], photoCount: 999,
    });
    expect(r.kind).toBe('no-shards');
  });

  it('launches and forwards URLs + options', async () => {
    const { starter, start } = makeStarter(true);
    const r = await maybeStartBackgroundFetch(starter, {
      jobId: 'job-7',
      title: 'Mosaic download',
      shardIds: ['s1', 's2'],
      photoCount: BG_FETCH_PHOTO_COUNT_THRESHOLD,
      downloadTotal: 100,
    });
    expect(r.kind).toBe('launched');
    expect(start).toHaveBeenCalledTimes(1);
    const [urls, options] = start.mock.calls[0]!;
    expect(urls).toEqual(['/api/shards/s1', '/api/shards/s2']);
    expect(options).toMatchObject({ id: 'job-7', title: 'Mosaic download', downloadTotal: 100 });
  });

  it('returns error (does NOT throw) if the BG-Fetch start fails', async () => {
    const { starter } = makeStarter(true, { fail: true });
    const r = await maybeStartBackgroundFetch(starter, {
      jobId: 'j', title: 't', shardIds: ['s1'], photoCount: 100,
    });
    expect(r.kind).toBe('error');
  });
});