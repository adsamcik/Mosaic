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
    expect(createAuthenticatedSourceStrategy('11111111-2222-3333-4444-555555555555').kind).toBe('authenticated');
  });

  it('fetchShard delegates to downloadShard', async () => {
    const s = createAuthenticatedSourceStrategy('11111111-2222-3333-4444-555555555555');
    shardServiceMocks.downloadShard.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const result = await s.fetchShard('shard-a', new AbortController().signal);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(shardServiceMocks.downloadShard).toHaveBeenCalledWith('shard-a');
  });

  it('fetchShards delegates to downloadShards with concurrency=4', async () => {
    const s = createAuthenticatedSourceStrategy('11111111-2222-3333-4444-555555555555');
    shardServiceMocks.downloadShards.mockResolvedValue([new Uint8Array([1]), new Uint8Array([2])]);
    const result = await s.fetchShards(['a', 'b'], new AbortController().signal);
    expect(result.map((r) => Array.from(r))).toEqual([[1], [2]]);
    expect(shardServiceMocks.downloadShards).toHaveBeenCalledWith(['a', 'b'], undefined, 4);
  });

  it('fetchShards short-circuits empty input', async () => {
    const s = createAuthenticatedSourceStrategy('11111111-2222-3333-4444-555555555555');
    const result = await s.fetchShards([], new AbortController().signal);
    expect(result).toEqual([]);
    expect(shardServiceMocks.downloadShards).not.toHaveBeenCalled();
  });

  it('fetchShard throws AbortError when signal pre-aborted', async () => {
    const s = createAuthenticatedSourceStrategy('11111111-2222-3333-4444-555555555555');
    const ctl = new AbortController(); ctl.abort();
    await expect(s.fetchShard('x', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(shardServiceMocks.downloadShard).not.toHaveBeenCalled();
  });

  it('resolveKey returns epochSeed from epoch-key service', async () => {
    const s = createAuthenticatedSourceStrategy('11111111-2222-3333-4444-555555555555');
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

describe('SourceStrategy.getScopeKey', () => {
  const ACCOUNT_A = '11111111-2222-3333-4444-555555555555';
  const ACCOUNT_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('auth scope is deterministic and prefixed', () => {
    const a1 = createAuthenticatedSourceStrategy(ACCOUNT_A).getScopeKey();
    const a2 = createAuthenticatedSourceStrategy(ACCOUNT_A).getScopeKey();
    expect(a1).toBe(a2);
    expect(a1.startsWith('auth:')).toBe(true);
    expect(a1.slice('auth:'.length)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('auth scopes for different accounts differ', () => {
    const a = createAuthenticatedSourceStrategy(ACCOUNT_A).getScopeKey();
    const b = createAuthenticatedSourceStrategy(ACCOUNT_B).getScopeKey();
    expect(a).not.toBe(b);
  });

  it('visitor scope is deterministic and prefixed', () => {
    const s1 = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: 'g', getTierKey: () => undefined }).getScopeKey();
    const s2 = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: 'g', getTierKey: () => undefined }).getScopeKey();
    expect(s1).toBe(s2);
    expect(s1.startsWith('visitor:')).toBe(true);
    expect(s1.slice('visitor:'.length)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('visitor scopes differ for different links and grants', () => {
    const v1 = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: 'g1', getTierKey: () => undefined }).getScopeKey();
    const v2 = createShareLinkSourceStrategy({ linkId: 'L2', grantToken: 'g1', getTierKey: () => undefined }).getScopeKey();
    const v3 = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: 'g2', getTierKey: () => undefined }).getScopeKey();
    expect(v1).not.toBe(v2);
    expect(v1).not.toBe(v3);
  });

  it('visitor null and empty grant collapse to the same scope', () => {
    const a = createShareLinkSourceStrategy({ linkId: 'L', grantToken: null, getTierKey: () => undefined }).getScopeKey();
    const b = createShareLinkSourceStrategy({ linkId: 'L', grantToken: '', getTierKey: () => undefined }).getScopeKey();
    expect(a).toBe(b);
  });

  it('auth and visitor scopes for the same input differ (domain separation)', () => {
    const a = createAuthenticatedSourceStrategy('L1').getScopeKey();
    const v = createShareLinkSourceStrategy({ linkId: 'L1', grantToken: null, getTierKey: () => undefined }).getScopeKey();
    expect(a).not.toBe(v);
  });

  it('does not leak the input account id in the hex tail', () => {
    const account = 'leaky-account-id-shouldnt-appear';
    const scope = createAuthenticatedSourceStrategy(account).getScopeKey();
    expect(scope.slice('auth:'.length)).not.toContain(account);
  });
});
