/**
 * Album Cover Service Tests
 *
 * Tests for album cover fetching and caching functionality.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AlbumCoverError,
    clearAllCovers,
    getAlbumCover,
    getCachedCover,
    getCoverCacheSize,
    getFirstPhotoForAlbum,
    hasCachedCover,
    releaseCover,
} from '../src/lib/album-cover-service';
import type { PhotoMeta } from '../src/workers/types';

// Mock dependencies
const mockDbClient = {
  getPhotos: vi.fn(),
};

const mockPhotoService = {
  loadPhoto: vi.fn(),
  releasePhoto: vi.fn(),
};

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(() => Promise.resolve(mockDbClient)),
}));

vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: (...args: unknown[]) => mockPhotoService.loadPhoto(...args),
  releasePhoto: (...args: unknown[]) => mockPhotoService.releasePhoto(...args),
}));

// Helper to create a mock photo
function createMockPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'test.jpg',
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    takenAt: '2024-01-01T12:00:00Z',
    tags: [],
    createdAt: '2024-01-01T12:00:00Z',
    updatedAt: '2024-01-01T12:00:00Z',
    shardIds: ['shard-1', 'shard-2'],
    epochId: 1,
    ...overrides,
  };
}

describe('Album Cover Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCovers();
  });

  afterEach(() => {
    clearAllCovers();
  });

  describe('AlbumCoverError', () => {
    it('creates error with albumId and cause', () => {
      const cause = new Error('Original error');
      const error = new AlbumCoverError('Test error', 'album-123', cause);

      expect(error.message).toBe('Test error');
      expect(error.albumId).toBe('album-123');
      expect(error.cause).toBe(cause);
      expect(error.name).toBe('AlbumCoverError');
    });

    it('creates error without cause', () => {
      const error = new AlbumCoverError('Test error', 'album-123');

      expect(error.message).toBe('Test error');
      expect(error.albumId).toBe('album-123');
      expect(error.cause).toBeUndefined();
    });
  });

  describe('getFirstPhotoForAlbum', () => {
    it('returns first photo from album', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);

      const result = await getFirstPhotoForAlbum('album-1');

      expect(result).toEqual(mockPhoto);
      expect(mockDbClient.getPhotos).toHaveBeenCalledWith('album-1', 1, 0);
    });

    it('returns null for empty album', async () => {
      mockDbClient.getPhotos.mockResolvedValue([]);

      const result = await getFirstPhotoForAlbum('album-1');

      expect(result).toBeNull();
    });

    it('throws AlbumCoverError on database error', async () => {
      mockDbClient.getPhotos.mockRejectedValue(new Error('DB error'));

      await expect(getFirstPhotoForAlbum('album-1')).rejects.toThrow(
        AlbumCoverError
      );
    });
  });

  describe('getAlbumCover', () => {
    const mockReadKey = new Uint8Array(32).fill(1);

    it('returns cover for album with photos', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      const result = await getAlbumCover('album-1', mockReadKey);

      expect(result).toEqual({
        blobUrl: 'blob:mock-1',
        photoId: 'photo-1',
        mimeType: 'image/jpeg',
      });
      expect(mockPhotoService.loadPhoto).toHaveBeenCalledWith(
        'photo-1',
        ['shard-1', 'shard-2'],
        mockReadKey,
        'image/jpeg'
      );
    });

    it('returns null for empty album', async () => {
      mockDbClient.getPhotos.mockResolvedValue([]);

      const result = await getAlbumCover('album-1', mockReadKey);

      expect(result).toBeNull();
      expect(mockPhotoService.loadPhoto).not.toHaveBeenCalled();
    });

    it('caches cover after loading', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      // First call - loads from service
      await getAlbumCover('album-1', mockReadKey);
      expect(mockPhotoService.loadPhoto).toHaveBeenCalledTimes(1);

      // Second call - returns from cache
      const result = await getAlbumCover('album-1', mockReadKey);
      expect(result?.blobUrl).toBe('blob:mock-1');
      expect(mockPhotoService.loadPhoto).toHaveBeenCalledTimes(1);
    });

    it('throws error for photo without shardIds', async () => {
      const mockPhoto = createMockPhoto({ shardIds: [] });
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);

      await expect(getAlbumCover('album-1', mockReadKey)).rejects.toThrow(
        'First photo has no shard IDs'
      );
    });

    it('deduplicates concurrent requests', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);

      // Create a promise that we can control
      let resolveLoad: (value: unknown) => void;
      const loadPromise = new Promise((resolve) => {
        resolveLoad = resolve;
      });
      mockPhotoService.loadPhoto.mockReturnValue(loadPromise);

      // Start two concurrent loads
      const promise1 = getAlbumCover('album-1', mockReadKey);
      const promise2 = getAlbumCover('album-1', mockReadKey);

      // Resolve the load
      resolveLoad!({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Both should return the same result
      expect(result1).toEqual(result2);
      // loadPhoto should only be called once
      expect(mockPhotoService.loadPhoto).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCachedCover', () => {
    it('returns null when not cached', () => {
      const result = getCachedCover('album-1');
      expect(result).toBeNull();
    });

    it('returns cached cover after loading', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      await getAlbumCover('album-1', new Uint8Array(32));

      const cached = getCachedCover('album-1');
      expect(cached).toEqual({
        blobUrl: 'blob:mock-1',
        photoId: 'photo-1',
        mimeType: 'image/jpeg',
      });
    });
  });

  describe('releaseCover', () => {
    it('removes cover from cache and releases photo', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      await getAlbumCover('album-1', new Uint8Array(32));
      expect(hasCachedCover('album-1')).toBe(true);

      releaseCover('album-1');

      expect(hasCachedCover('album-1')).toBe(false);
      expect(mockPhotoService.releasePhoto).toHaveBeenCalledWith('photo-1');
    });

    it('does nothing for non-existent cover', () => {
      releaseCover('album-nonexistent');
      expect(mockPhotoService.releasePhoto).not.toHaveBeenCalled();
    });
  });

  describe('clearAllCovers', () => {
    it('clears all cached covers', async () => {
      const mockPhoto1 = createMockPhoto({ id: 'photo-1', albumId: 'album-1' });
      const mockPhoto2 = createMockPhoto({ id: 'photo-2', albumId: 'album-2' });

      mockDbClient.getPhotos
        .mockResolvedValueOnce([mockPhoto1])
        .mockResolvedValueOnce([mockPhoto2]);

      mockPhotoService.loadPhoto
        .mockResolvedValueOnce({
          blobUrl: 'blob:mock-1',
          mimeType: 'image/jpeg',
          size: 12345,
        })
        .mockResolvedValueOnce({
          blobUrl: 'blob:mock-2',
          mimeType: 'image/jpeg',
          size: 12345,
        });

      await getAlbumCover('album-1', new Uint8Array(32));
      await getAlbumCover('album-2', new Uint8Array(32));

      expect(getCoverCacheSize()).toBe(2);

      clearAllCovers();

      expect(getCoverCacheSize()).toBe(0);
      expect(mockPhotoService.releasePhoto).toHaveBeenCalledWith('photo-1');
      expect(mockPhotoService.releasePhoto).toHaveBeenCalledWith('photo-2');
    });
  });

  describe('hasCachedCover', () => {
    it('returns false when not cached', () => {
      expect(hasCachedCover('album-1')).toBe(false);
    });

    it('returns true after loading', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      await getAlbumCover('album-1', new Uint8Array(32));

      expect(hasCachedCover('album-1')).toBe(true);
    });
  });

  describe('getCoverCacheSize', () => {
    it('returns 0 initially', () => {
      expect(getCoverCacheSize()).toBe(0);
    });

    it('tracks cache size correctly', async () => {
      const mockPhoto = createMockPhoto();
      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      await getAlbumCover('album-1', new Uint8Array(32));
      expect(getCoverCacheSize()).toBe(1);

      releaseCover('album-1');
      expect(getCoverCacheSize()).toBe(0);
    });
  });
});
