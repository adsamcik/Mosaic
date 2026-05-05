import { beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { executePhotoTask, type DownloadPlanEntry, type PhotoPipelineDeps } from '../photo-pipeline';
import { createDecryptCache } from '../decrypt-cache';
import type { ShardMirror } from '../shard-mirror';
import type { CryptoPool } from '../../crypto-pool';

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return new Uint8Array(buf);
}

interface FakeMirror extends ShardMirror {
  _store: Map<string, Uint8Array>;
  _hits: number;
  _puts: number;
}

function makeFakeMirror(): FakeMirror {
  const store = new Map<string, Uint8Array>();
  let hits = 0; let puts = 0;
  const m: FakeMirror = {
    _store: store,
    _hits: 0,
    _puts: 0,
    async get(hash: string): Promise<Uint8Array | null> {
      const b = store.get(hash);
      if (!b) return null;
      // Re-verify, mirroring real implementation.
      const actual = await sha256(b);
      const actualHex = [...actual].map((x) => x.toString(16).padStart(2, '0')).join('');
      if (actualHex !== hash) { store.delete(hash); return null; }
      hits += 1; m._hits = hits;
      return b;
    },
    async put(hash: string, bytes: Uint8Array): Promise<void> {
      store.set(hash, bytes);
      puts += 1; m._puts = puts;
    },
    async evict(hash: string): Promise<void> { store.delete(hash); },
    async trim(): Promise<{ readonly evicted: number; readonly bytesFreed: number }> {
      return { evicted: 0, bytesFreed: 0 };
    },
    async stats(): Promise<{
      readonly entries: number; readonly bytesUsed: number; readonly bytesBudget: number;
      readonly hits: number; readonly misses: number; readonly puts: number; readonly evictions: number;
    }> {
      return { entries: store.size, bytesUsed: 0, bytesBudget: 0, hits, misses: 0, puts, evictions: 0 };
    },
  };
  return m;
}

function makePool(): CryptoPool {
  return {
    size: 1,
    verifyShard: vi.fn(async (): Promise<void> => undefined),
    decryptShard: vi.fn(async (b: Uint8Array): Promise<Uint8Array> => b),
    decryptShardWithTierKey: vi.fn(async (b: Uint8Array): Promise<Uint8Array> => b),
    getStats: vi.fn(async () => ({ size: 1, idle: 1, busy: 0, queued: 0 })),
    shutdown: vi.fn(async (): Promise<void> => undefined),
  };
}

const SHARD_A = new Uint8Array([1, 2, 3, 4]);
const SHARD_B = new Uint8Array([5, 6, 7, 8]);

let HASH_A: Uint8Array;
let HASH_B: Uint8Array;
let entry: DownloadPlanEntry;

beforeEach(async () => {
  await sodium.ready;
  HASH_A = await sha256(SHARD_A);
  HASH_B = await sha256(SHARD_B);
  entry = {
    photoId: 'photo-1',
    epochId: 7,
    tier: 3,
    shardIds: ['s-a', 's-b'],
    expectedHashes: [HASH_A, HASH_B],
    filename: 'p.jpg',
    totalBytes: SHARD_A.byteLength + SHARD_B.byteLength,
  };
});

function baseDeps(extra: Partial<PhotoPipelineDeps> = {}): PhotoPipelineDeps {
  return {
    pool: makePool(),
    fetchShards: vi.fn(async (ids: string[]): Promise<Uint8Array[]> => ids.map((id) => (id === 's-a' ? SHARD_A : SHARD_B))),
    getEpochSeed: vi.fn(async (): Promise<Uint8Array> => new Uint8Array(32).fill(7)),
    writePhotoChunk: vi.fn(async (): Promise<void> => undefined),
    truncatePhoto: vi.fn(async (): Promise<void> => undefined),
    getPhotoFileLength: vi.fn(async (): Promise<number | null> => null),
    reportBytesWritten: vi.fn(),
    ...extra,
  };
}

describe('photo-pipeline × ShardMirror integration', () => {
  it('on miss, fetches from network and populates the mirror', async () => {
    const mirror = makeFakeMirror();
    const deps = baseDeps({ mirror });
    const out = await executePhotoTask({ jobId: 'j', albumId: 'a', entry, signal: new AbortController().signal }, deps);
    expect(out).toEqual({ kind: 'done', bytesWritten: 8 });
    expect(deps.fetchShards).toHaveBeenCalledTimes(1);
    expect(mirror._puts).toBe(2);
    expect(mirror._store.size).toBe(2);
  });

  it('on full hit, skips network entirely', async () => {
    const mirror = makeFakeMirror();
    const hexA = [...HASH_A].map((b) => b.toString(16).padStart(2, '0')).join('');
    const hexB = [...HASH_B].map((b) => b.toString(16).padStart(2, '0')).join('');
    mirror._store.set(hexA, SHARD_A);
    mirror._store.set(hexB, SHARD_B);
    const deps = baseDeps({ mirror });
    const out = await executePhotoTask({ jobId: 'j', albumId: 'a', entry, signal: new AbortController().signal }, deps);
    expect(out).toEqual({ kind: 'done', bytesWritten: 8 });
    expect(deps.fetchShards).not.toHaveBeenCalled();
    expect(mirror._hits).toBe(2);
    // No new puts on full hit.
    expect(mirror._puts).toBe(0);
  });

  it('falls through to network when on-disk bytes are tampered with (hash mismatch)', async () => {
    const mirror = makeFakeMirror();
    const hexA = [...HASH_A].map((b) => b.toString(16).padStart(2, '0')).join('');
    // Inject WRONG bytes under HASH_A's key — fake mirror.get re-verifies and evicts.
    mirror._store.set(hexA, new Uint8Array([99, 99, 99, 99]));
    const deps = baseDeps({ mirror });
    const out = await executePhotoTask({ jobId: 'j', albumId: 'a', entry, signal: new AbortController().signal }, deps);
    expect(out).toEqual({ kind: 'done', bytesWritten: 8 });
    // Both shards fetched (A miss because tampered, B miss because absent).
    expect(deps.fetchShards).toHaveBeenCalledTimes(1);
    const calledIds = (deps.fetchShards as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    expect(calledIds).toEqual(['s-a', 's-b']);
  });

  it('only fetches the missing shards on partial hit', async () => {
    const mirror = makeFakeMirror();
    const hexA = [...HASH_A].map((b) => b.toString(16).padStart(2, '0')).join('');
    mirror._store.set(hexA, SHARD_A); // A cached, B not.
    const deps = baseDeps({ mirror });
    await executePhotoTask({ jobId: 'j', albumId: 'a', entry, signal: new AbortController().signal }, deps);
    const calledIds = (deps.fetchShards as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    expect(calledIds).toEqual(['s-b']);
    // B newly cached.
    expect(mirror._puts).toBe(1);
  });

  it('decrypt cache hit avoids re-deriving the epoch seed across photos', async () => {
    const cache = createDecryptCache(8);
    const deps = baseDeps({ decryptCache: cache });
    // First photo — fills cache.
    await executePhotoTask({ jobId: 'j', albumId: 'a', entry, signal: new AbortController().signal }, deps);
    expect(deps.getEpochSeed).toHaveBeenCalledTimes(1);
    // Second photo with same epoch — should reuse.
    await executePhotoTask({ jobId: 'j', albumId: 'a', entry: { ...entry, photoId: 'photo-2' }, signal: new AbortController().signal }, deps);
    expect(deps.getEpochSeed).toHaveBeenCalledTimes(1); // still 1 — no second derivation
  });

  it('different epochs do not collide in the decrypt cache', async () => {
    const cache = createDecryptCache(8);
    const deps = baseDeps({ decryptCache: cache });
    await executePhotoTask({ jobId: 'j', albumId: 'a', entry, signal: new AbortController().signal }, deps);
    await executePhotoTask({ jobId: 'j', albumId: 'a', entry: { ...entry, epochId: 99, photoId: 'p2' }, signal: new AbortController().signal }, deps);
    expect(deps.getEpochSeed).toHaveBeenCalledTimes(2);
  });
});
