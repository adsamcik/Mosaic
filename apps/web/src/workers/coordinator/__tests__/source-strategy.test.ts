import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shardServiceMocks = vi.hoisted(() => ({
  downloadShard: vi.fn<(shardId: string) => Promise<Uint8Array>>(),
  downloadShards: vi.fn<(ids: string[], onProgress?: unknown, max?: number) => Promise<Uint8Array[]>>(),
  downloadShardViaShareLink: vi.fn<(linkId: string, shardId: string, grant?: string) => Promise<Uint8Array>>(),
}));

const epochKeyMocks = vi.hoisted(() => ({
  getOrFetchEpochKey: vi.fn<(albumId: string, epochId: number) => Promise<{ epochSeed: Uint8Array }>>(),
}));

vi.mock('../../../lib/shard-service', () => ({
  downloadShard: shardServiceMocks.downloadShard,
  downloadShards: shardServiceMocks.downloadShards,
  downloadShardViaShareLink: shardServiceMocks.downloadShardViaShareLink,
  ShardDownloadError: class extends Error {},
}));
vi.mock('../../../lib/epoch-key-service', () => ({
  getOrFetchEpochKey: epochKeyMocks.getOrFetchEpochKey,
}));

import { createAuthenticatedSourceStrategy } from '../source-strategy-auth';
import { createShareLinkSourceStrategy } from '../source-strategy-sharelink';
import { DownloadError } from '../../crypto-pool';
import type { LinkDecryptionKey } from '../../types';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('createAuthenticatedSourceStrategy', () => {
  it('reports kind=authenticated', () => {
    expect(createAuthenticatedSourceStrategy().kind).toBe('authenticated');
  });

  it('fetchShard delegates to downloadShard', async () => {
    const s = createAuthenticatedSourceStrategy();
    shardServiceMocks.downloadShard.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const result = await s.fetchShard('shard-a', new AbortController().signal);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(shardServiceMocks.downloadShard).toHaveBeenCalledWith('shard-a');
  });

  it('fetchShards delegates to downloadShards with concurrency=4', async () => {
    const s = createAuthenticatedSourceStrategy();
    shardServiceMocks.downloadShards.mockResolvedValue([new Uint8Array([1]), new Uint8Array([2])]);
    const result = await s.fetchShards(['a', 'b'], new AbortController().signal);
    expect(result.map((r) => Array.from(r))).toEqual([[1], [2]]);
    expect(shardServiceMocks.downloadShards).toHaveBeenCalledWith(['a', 'b'], undefined, 4);
  });

  it('fetchShards short-circuits empty input', async () => {
    const s = createAuthenticatedSourceStrategy();
    const result = await s.fetchShards([], new AbortController().signal);
    expect(result).toEqual([]);
    expect(shardServiceMocks.downloadShards).not.toHaveBeenCalled();
  });

  it('fetchShard throws AbortError when signal pre-aborted', async () => {
    const s = createAuthenticatedSourceStrategy();
    const ctl = new AbortController(); ctl.abort();
    await expect(s.fetchShard('x', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(shardServiceMocks.downloadShard).not.toHaveBeenCalled();
  });

  it('resolveKey returns epochSeed from epoch-key service', async () => {
    const s = createAuthenticatedSourceStrategy();
    const seed = new Uint8Array(32).fill(7);
    epochKeyMocks.getOrFetchEpochKey.mockResolvedValue({ epochSeed: seed });
    const out = await s.resolveKey('album-1', 5);
    expect(out).toBe(seed);
    expect(epochKeyMocks.getOrFetchEpochKey).toHaveBeenCalledWith('album-1', 5);
  });
});

describe('createShareLinkSourceStrategy', () => {
  it('reports kind=share-link', () => {
    const s = createShareLinkSourceStrategy({ linkId: 'L', getTierKey: () => undefined });
    expect(s.kind).toBe('share-link');
  });

  it('fetchShard delegates to downloadShardViaShareLink with grant token', async () => {
    shardServiceMocks.downloadShardViaShareLink.mockResolvedValue(new Uint8Array([9]));
    const s = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: 'g-token', getTierKey: () => undefined });
    const out = await s.fetchShard('sh', new AbortController().signal);
    expect(out).toEqual(new Uint8Array([9]));
    expect(shardServiceMocks.downloadShardViaShareLink).toHaveBeenCalledWith('L1', 'sh', 'g-token');
  });

  it('fetchShard omits grant when grantToken is null', async () => {
    shardServiceMocks.downloadShardViaShareLink.mockResolvedValue(new Uint8Array());
    const s = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: null, getTierKey: () => undefined });
    await s.fetchShard('sh', new AbortController().signal);
    expect(shardServiceMocks.downloadShardViaShareLink).toHaveBeenCalledWith('L1', 'sh', undefined);
  });

  it('fetchShards preserves order across batches', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    shardServiceMocks.downloadShardViaShareLink.mockImplementation(async (_l, id) => new Uint8Array([id.charCodeAt(0)]));
    const s = createShareLinkSourceStrategy({ linkId: 'L', grantToken: 't', getTierKey: () => undefined });
    const out = await s.fetchShards(ids, new AbortController().signal);
    expect(out.map((b) => b[0])).toEqual(ids.map((id) => id.charCodeAt(0)));
  });

  it('fetchShards short-circuits empty input', async () => {
    const s = createShareLinkSourceStrategy({ linkId: 'L', getTierKey: () => undefined });
    const out = await s.fetchShards([], new AbortController().signal);
    expect(out).toEqual([]);
    expect(shardServiceMocks.downloadShardViaShareLink).not.toHaveBeenCalled();
  });

  it('resolveKey returns the 32-byte tier key bytes', async () => {
    const tier3: LinkDecryptionKey = new Uint8Array(32).fill(11);
    const s = createShareLinkSourceStrategy({ linkId: 'L', getTierKey: (epoch) => (epoch === 9 ? tier3 : undefined) });
    const out = await s.resolveKey('album', 9);
    expect(out).toBe(tier3);
  });

  it('resolveKey throws AccessRevoked when tier key is missing', async () => {
    const s = createShareLinkSourceStrategy({ linkId: 'L', getTierKey: () => undefined });
    await expect(s.resolveKey('album', 1)).rejects.toBeInstanceOf(DownloadError);
    try { await s.resolveKey('album', 1); } catch (err) {
      expect((err as DownloadError).code).toBe('AccessRevoked');
    }
  });

  it('resolveKey throws IllegalState when tier key is a handle (string)', async () => {
    const handle = 'tier-handle-abc' as unknown as LinkDecryptionKey;
    const s = createShareLinkSourceStrategy({ linkId: 'L', getTierKey: () => handle });
    try {
      await s.resolveKey('album', 1);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).code).toBe('IllegalState');
    }
  });
});
