import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDBPDatabase } from 'idb';

const wasmMocks = vi.hoisted(() => ({
  initRustWasm: vi.fn().mockResolvedValue(undefined),
  computePlaintextContentHash: vi.fn((bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    if (text === 'mosaic-content-hash') {
      return '866ee6120613df79e6daf58a445398339d9da6a7a07f4d5a1902fc35ed3dc877';
    }
    return bytes.byteLength === 6 ? 'a'.repeat(64) : 'b'.repeat(64);
  }),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: wasmMocks.initRustWasm,
  computePlaintextContentHash: wasmMocks.computePlaintextContentHash,
}));

import {
  computeContentHash,
  ContentHashDedup,
} from '../content-hash';
import type { AlbumContentHashRecord, UploadQueueDB } from '../upload/types';

describe('computeContentHash', () => {
  it('returns deterministic SHA-256 hex for the same bytes', async () => {
    const bytes = new TextEncoder().encode('mosaic-content-hash');

    const first = await computeContentHash(bytes);
    const second = await computeContentHash(bytes);

    expect(first).toBe(second);
    expect(first).toBe('866ee6120613df79e6daf58a445398339d9da6a7a07f4d5a1902fc35ed3dc877');
    expect(wasmMocks.initRustWasm).toHaveBeenCalledTimes(1);
    expect(wasmMocks.computePlaintextContentHash).toHaveBeenCalledWith(bytes);
  });

  it('returns a 64-character lowercase hex string', async () => {
    const hash = await computeContentHash(new Uint8Array([0, 1, 2, 253, 254, 255]));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles large byte arrays deterministically', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 251;
    }

    const first = await computeContentHash(bytes);
    const second = await computeContentHash(bytes);

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });
});

describe('ContentHashDedup', () => {
  let records: AlbumContentHashRecord[];

  beforeEach(async () => {
    vi.clearAllMocks();
    records = [];
  });

  it('looks up records within the same album only and clears by album', async () => {
    const fakeDb = {
      getFromIndex: async (_store: string, _index: string, key: [string, string]) =>
        records.find((record) => record.albumId === key[0] && record.contentHash === key[1]),
      put: async (_store: string, value: AlbumContentHashRecord) => {
        records = records.filter(
          (record) => record.albumId !== value.albumId || record.contentHash !== value.contentHash,
        );
        records.push(value);
      },
      transaction: () => ({
        store: {
          index: () => ({
            getAllKeys: async (albumId: string) =>
              records
                .filter((record) => record.albumId === albumId)
                .map((record) => [record.albumId, record.contentHash] as [string, string]),
          }),
          delete: async (key: [string, string]) => {
            records = records.filter((record) => record.albumId !== key[0] || record.contentHash !== key[1]);
          },
        },
        done: Promise.resolve(),
      }),
    } as unknown as IDBPDatabase<UploadQueueDB>;
    const dedup = new ContentHashDedup(fakeDb);

    await dedup.record('album-a', 'a'.repeat(64), 'photo-a');
    await dedup.record('album-b', 'a'.repeat(64), 'photo-b');

    await expect(dedup.lookup('album-a', 'a'.repeat(64))).resolves.toMatchObject({ photoId: 'photo-a' });
    await expect(dedup.lookup('album-b', 'a'.repeat(64))).resolves.toMatchObject({ photoId: 'photo-b' });

    await dedup.clear('album-a');

    await expect(dedup.lookup('album-a', 'a'.repeat(64))).resolves.toBeNull();
    await expect(dedup.lookup('album-b', 'a'.repeat(64))).resolves.toMatchObject({ photoId: 'photo-b' });
  });
});
