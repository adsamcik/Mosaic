import { describe, expect, it, vi } from 'vitest';
import {
  loadAllAlbumPhotos,
  searchAllAlbumPhotos,
} from '../src/lib/photo-query-pagination';
import type { PhotoMeta } from '../src/workers/types';

function createPhoto(id: string): PhotoMeta {
  return {
    id,
    assetId: id,
    albumId: 'album-1',
    filename: `${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    shardIds: [],
    epochId: 1,
  };
}

describe('photo query pagination', () => {
  it('loads every getPhotos page until a short page is returned', async () => {
    const pages = [
      [createPhoto('photo-1'), createPhoto('photo-2')],
      [createPhoto('photo-3'), createPhoto('photo-4')],
      [createPhoto('photo-5')],
    ];
    const getPhotos = vi
      .fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1])
      .mockResolvedValueOnce(pages[2]);

    const photos = await loadAllAlbumPhotos({ getPhotos }, 'album-1', 2);

    expect(photos.map((photo) => photo.id)).toEqual([
      'photo-1',
      'photo-2',
      'photo-3',
      'photo-4',
      'photo-5',
    ]);
    expect(getPhotos).toHaveBeenNthCalledWith(1, 'album-1', 2, 0);
    expect(getPhotos).toHaveBeenNthCalledWith(2, 'album-1', 2, 2);
    expect(getPhotos).toHaveBeenNthCalledWith(3, 'album-1', 2, 4);
  });

  it('loads an empty trailing getPhotos page for exact page-size boundaries', async () => {
    const getPhotos = vi
      .fn()
      .mockResolvedValueOnce([createPhoto('photo-1'), createPhoto('photo-2')])
      .mockResolvedValueOnce([createPhoto('photo-3'), createPhoto('photo-4')])
      .mockResolvedValueOnce([]);

    const photos = await loadAllAlbumPhotos({ getPhotos }, 'album-1', 2);

    expect(photos).toHaveLength(4);
    expect(getPhotos).toHaveBeenCalledTimes(3);
    expect(getPhotos).toHaveBeenLastCalledWith('album-1', 2, 4);
  });

  it('loads every searchPhotos page with the same query', async () => {
    const searchPhotos = vi
      .fn()
      .mockResolvedValueOnce([createPhoto('photo-1'), createPhoto('photo-2')])
      .mockResolvedValueOnce([createPhoto('photo-3')]);

    const photos = await searchAllAlbumPhotos(
      { searchPhotos },
      'album-1',
      'cats',
      2,
    );

    expect(photos.map((photo) => photo.id)).toEqual([
      'photo-1',
      'photo-2',
      'photo-3',
    ]);
    expect(searchPhotos).toHaveBeenNthCalledWith(1, 'album-1', 'cats', 2, 0);
    expect(searchPhotos).toHaveBeenNthCalledWith(2, 'album-1', 'cats', 2, 2);
  });
});
