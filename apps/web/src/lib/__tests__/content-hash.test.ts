import { beforeEach, describe, expect, it } from 'vitest';
import type { IDBPDatabase } from 'idb';
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
