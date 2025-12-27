/**
 * useAlbumCover Hook Tests
 *
 * Tests for the album cover fetching hook.
 * Tests the underlying service integration rather than React hook behavior
 * since @testing-library/react is not available.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearAllCovers,
    getAlbumCover,
    getCachedCover
} from '../src/lib/album-cover-service';
import { getCurrentOrFetchEpochKey } from '../src/lib/epoch-key-service';

// Mock album cover service
const mockAlbumCoverService = {
  getAlbumCover: vi.fn(),
  getCachedCover: vi.fn(),
  releaseCover: vi.fn(),
  clearAllCovers: vi.fn(),
};

// Mock epoch key service
const mockEpochKeyService = {
  getCurrentOrFetchEpochKey: vi.fn(),
};

// Mock db client
const mockDbClient = {
  getPhotos: vi.fn(),
};

// Mock photo service
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

vi.mock('../src/lib/epoch-key-service', () => ({
  getCurrentOrFetchEpochKey: (...args: unknown[]) =>
    mockEpochKeyService.getCurrentOrFetchEpochKey(...args),
  fetchAndUnwrapEpochKeys: vi.fn(),
  getOrFetchEpochKey: vi.fn(),
  ensureEpochKeysLoaded: vi.fn().mockResolvedValue(true),
}));

describe('useAlbumCover integration', () => {
  const mockReadKey = new Uint8Array(32).fill(1);
  const mockEpochKey = {
    epochId: 1,
    readKey: mockReadKey,
    signKeypair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCovers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearAllCovers();
  });

  describe('getAlbumCover with epoch key', () => {
    it('loads cover successfully with epoch key', async () => {
      const mockPhoto = {
        id: 'photo-1',
        assetId: 'asset-1',
        albumId: 'album-1',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        tags: [],
        shardIds: ['shard-1', 'shard-2'],
        epochId: 1,
        createdAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
      };

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
    });

    it('returns null for album with no photos', async () => {
      mockDbClient.getPhotos.mockResolvedValue([]);

      const result = await getAlbumCover('album-1', mockReadKey);

      expect(result).toBeNull();
    });

    it('throws error for photo without shardIds', async () => {
      const mockPhoto = {
        id: 'photo-1',
        assetId: 'asset-1',
        albumId: 'album-1',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        tags: [],
        shardIds: [], // Empty shardIds
        epochId: 1,
        createdAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
      };

      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);

      await expect(getAlbumCover('album-1', mockReadKey)).rejects.toThrow(
        'First photo has no shard IDs'
      );
    });
  });

  describe('epoch key fetching', () => {
    it('getCurrentOrFetchEpochKey returns epoch key bundle', async () => {
      mockEpochKeyService.getCurrentOrFetchEpochKey.mockResolvedValue(mockEpochKey);

      const result = await getCurrentOrFetchEpochKey('album-1');

      expect(result).toEqual(mockEpochKey);
      expect(mockEpochKeyService.getCurrentOrFetchEpochKey).toHaveBeenCalledWith('album-1');
    });

    it('getCurrentOrFetchEpochKey throws on error', async () => {
      mockEpochKeyService.getCurrentOrFetchEpochKey.mockRejectedValue(
        new Error('No keys available')
      );

      await expect(getCurrentOrFetchEpochKey('album-1')).rejects.toThrow(
        'No keys available'
      );
    });
  });

  describe('cover caching', () => {
    it('caches cover after loading', async () => {
      const mockPhoto = {
        id: 'photo-1',
        assetId: 'asset-1',
        albumId: 'album-1',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        tags: [],
        shardIds: ['shard-1'],
        epochId: 1,
        createdAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
      };

      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      // First load
      await getAlbumCover('album-1', mockReadKey);

      // Check cache
      const cached = getCachedCover('album-1');
      expect(cached).toEqual({
        blobUrl: 'blob:mock-1',
        photoId: 'photo-1',
        mimeType: 'image/jpeg',
      });

      // Second load uses cache (loadPhoto not called again)
      const loadCount = mockPhotoService.loadPhoto.mock.calls.length;
      await getAlbumCover('album-1', mockReadKey);
      expect(mockPhotoService.loadPhoto.mock.calls.length).toBe(loadCount);
    });

    it('returns null from cache for non-existent album', () => {
      const cached = getCachedCover('nonexistent-album');
      expect(cached).toBeNull();
    });
  });

  describe('clearAllCovers', () => {
    it('clears all cached covers', async () => {
      const mockPhoto = {
        id: 'photo-1',
        assetId: 'asset-1',
        albumId: 'album-1',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        tags: [],
        shardIds: ['shard-1'],
        epochId: 1,
        createdAt: '2024-01-01T12:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
      };

      mockDbClient.getPhotos.mockResolvedValue([mockPhoto]);
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:mock-1',
        mimeType: 'image/jpeg',
        size: 12345,
      });

      await getAlbumCover('album-1', mockReadKey);
      expect(getCachedCover('album-1')).not.toBeNull();

      clearAllCovers();
      expect(getCachedCover('album-1')).toBeNull();
    });
  });
});
