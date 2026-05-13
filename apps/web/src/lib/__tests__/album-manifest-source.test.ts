/**
 * Tests for {@link getCurrentAlbumManifest}.
 *
 * Mirrors the production code's contract:
 *   1. Reads all photos for an album from the DB worker via
 *      {@link loadAllAlbumPhotos} (paginated underneath).
 *   2. Prefers `originalShardIds` (the canonical per-tier field) but falls
 *      back to the deprecated flat `shardIds` for legacy rows.
 *   3. Returns an empty `photos` array when the album has no entries.
 *   4. Strips DB-internal fields and produces a structurally complete,
 *      independent (defensively-copied) manifest suitable for
 *      `coordinator.computeAlbumDiff`.
 */

import { describe, expect, it, vi } from 'vitest';
import { getCurrentAlbumManifest } from '../album-manifest-source';
import type { DbWorkerApi, PhotoMeta } from '../../workers/types';
import { PHOTO_QUERY_PAGE_SIZE } from '../photo-query-pagination';

function basePhoto(overrides: Partial<PhotoMeta>): PhotoMeta {
  return {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo-1.jpg',
    mimeType: 'image/jpeg',
    width: 4032,
    height: 3024,
    tags: [],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    shardIds: [],
    epochId: 1,
    ...overrides,
  };
}

function fakeDb(pages: PhotoMeta[][]): Pick<DbWorkerApi, 'getPhotos'> {
  const getPhotos = vi.fn(async (_albumId: string, limit: number, offset: number) => {
    const pageIndex = Math.floor(offset / limit);
    return pages[pageIndex] ?? [];
  });
  return { getPhotos };
}

describe('getCurrentAlbumManifest', () => {
  it('projects DB rows into the manifest shape and prefers originalShardIds', async () => {
    const db = fakeDb([
      [
        basePhoto({
          id: 'p1',
          epochId: 2,
          originalShardIds: ['orig-1a', 'orig-1b'],
          shardIds: ['legacy-1'], // should be ignored when originals exist
        }),
        basePhoto({
          id: 'p2',
          epochId: 3,
          originalShardIds: ['orig-2'],
        }),
      ],
    ]);

    const manifest = await getCurrentAlbumManifest('album-1', db);

    expect(manifest).toEqual({
      albumId: 'album-1',
      photos: [
        { photoId: 'p1', epochId: 2, tier3ShardIds: ['orig-1a', 'orig-1b'] },
        { photoId: 'p2', epochId: 3, tier3ShardIds: ['orig-2'] },
      ],
    });
  });

  it('falls back to deprecated flat shardIds for legacy rows', async () => {
    const db = fakeDb([
      [
        basePhoto({
          id: 'legacy',
          epochId: 7,
          shardIds: ['s-a', 's-b'],
        }),
      ],
    ]);

    const manifest = await getCurrentAlbumManifest('album-1', db);

    expect(manifest.photos).toEqual([
      { photoId: 'legacy', epochId: 7, tier3ShardIds: ['s-a', 's-b'] },
    ]);
  });

  it('emits an empty tier3ShardIds array when neither field is populated', async () => {
    const db = fakeDb([
      [
        basePhoto({
          id: 'no-shards',
          epochId: 1,
          shardIds: [],
        }),
      ],
    ]);

    const manifest = await getCurrentAlbumManifest('album-1', db);

    expect(manifest.photos).toHaveLength(1);
    expect(manifest.photos[0]?.tier3ShardIds).toEqual([]);
  });

  it('returns an empty photos array for an album with no DB rows', async () => {
    const db = fakeDb([[]]);

    const manifest = await getCurrentAlbumManifest('empty-album', db);

    expect(manifest).toEqual({ albumId: 'empty-album', photos: [] });
  });

  it('defensively copies shard ID arrays so the manifest is independent of DB buffers', async () => {
    const originalShardIds = ['orig-a'];
    const db = fakeDb([
      [
        basePhoto({
          id: 'p1',
          epochId: 4,
          originalShardIds,
        }),
      ],
    ]);

    const manifest = await getCurrentAlbumManifest('album-1', db);
    expect(manifest.photos).toHaveLength(1);
    const returnedShardIds = manifest.photos[0]?.tier3ShardIds as string[];

    // Mutating the returned array must not affect the DB row.
    returnedShardIds.push('extra');
    expect(originalShardIds).toEqual(['orig-a']);
  });

  it('paginates through multiple DB pages', async () => {
    const fullPage = Array.from({ length: PHOTO_QUERY_PAGE_SIZE }, (_, idx) =>
      basePhoto({
        id: `p${idx}`,
        epochId: 1,
        originalShardIds: [`s-${idx}`],
      }),
    );
    const partialPage = [
      basePhoto({ id: 'p-last', epochId: 1, originalShardIds: ['s-last'] }),
    ];
    const db = fakeDb([fullPage, partialPage]);

    const manifest = await getCurrentAlbumManifest('album-1', db);

    expect(manifest.photos).toHaveLength(PHOTO_QUERY_PAGE_SIZE + 1);
    expect(manifest.photos[manifest.photos.length - 1]).toEqual({
      photoId: 'p-last',
      epochId: 1,
      tier3ShardIds: ['s-last'],
    });
    expect(db.getPhotos).toHaveBeenCalledTimes(2);
  });
});
