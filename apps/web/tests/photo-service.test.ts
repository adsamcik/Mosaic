/**
 * Photo Service Unit Tests
 *
 * Tests for the photo assembly and caching service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPhotoCache,
  clearThumbnailCache,
  getCachedPhoto,
  getCacheStats,
  getThumbnailCacheStats,
  isPhotoCached,
  loadPhoto,
  loadThumbnailFromBase64,
  PhotoAssemblyError,
  releasePhoto,
  releaseThumbnail,
} from '../src/lib/photo-service';

// Mock dependencies
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

vi.mock('../src/lib/shard-service', () => ({
  downloadShards: vi.fn(),
}));

// Mock URL.createObjectURL and URL.revokeObjectURL
const mockBlobUrls = new Map<string, Blob>();
let blobUrlCounter = 0;

const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

describe('Photo Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPhotoCache();
    blobUrlCounter = 0;
    mockBlobUrls.clear();

    // Mock URL methods
    globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:mock-${++blobUrlCounter}`;
      mockBlobUrls.set(url, blob);
      return url;
    });

    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      mockBlobUrls.delete(url);
    });
  });

  afterEach(() => {
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  describe('loadPhoto', () => {
    it('downloads, decrypts, and assembles photo', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      // Mock encrypted shards
      const encryptedShard1 = new Uint8Array([1, 2, 3, 4, 5]);
      const encryptedShard2 = new Uint8Array([6, 7, 8, 9, 10]);

      // Mock decrypted chunks
      const decryptedChunk1 = new Uint8Array([11, 12, 13]);
      const decryptedChunk2 = new Uint8Array([14, 15, 16]);

      vi.mocked(downloadShards).mockResolvedValue([
        encryptedShard1,
        encryptedShard2,
      ]);

      const mockCrypto = {
        decryptShardWithEpoch: vi
          .fn()
          .mockResolvedValueOnce(decryptedChunk1)
          .mockResolvedValueOnce(decryptedChunk2),
      };
      vi.mocked(getCryptoClient).mockResolvedValue(mockCrypto as any);

      const epochKey = 'epoch-handle-42' as never;
      const result = await loadPhoto(
        'photo-1',
        ['shard-a', 'shard-b'],
        epochKey,
        'image/jpeg',
      );

      expect(downloadShards).toHaveBeenCalledWith(
        ['shard-a', 'shard-b'],
        undefined, // no progress callback when not provided
      );
      expect(mockCrypto.decryptShardWithEpoch).toHaveBeenCalledTimes(2);
      expect(result.blobUrl).toMatch(/^blob:mock-/);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.size).toBe(6); // 3 + 3 bytes
    });

    it('returns cached result on second call', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      const encryptedShard = new Uint8Array([1, 2, 3]);
      const decryptedChunk = new Uint8Array([4, 5, 6]);

      vi.mocked(downloadShards).mockResolvedValue([encryptedShard]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(decryptedChunk),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      // First call
      const result1 = await loadPhoto(
        'photo-cached',
        ['shard-1'],
        epochKey,
        'image/png',
      );

      // Second call - should return cached
      const result2 = await loadPhoto(
        'photo-cached',
        ['shard-1'],
        epochKey,
        'image/png',
      );

      // Should only download once
      expect(downloadShards).toHaveBeenCalledTimes(1);
      expect(result1.blobUrl).toBe(result2.blobUrl);
    });

    it('skips cache when skipCache is true', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      const encryptedShard = new Uint8Array([1, 2, 3]);
      const decryptedChunk = new Uint8Array([4, 5, 6]);

      vi.mocked(downloadShards).mockResolvedValue([encryptedShard]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(decryptedChunk),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      // First call
      await loadPhoto('photo-skip', ['shard-1'], epochKey, 'image/png');

      // Second call with skipCache
      await loadPhoto('photo-skip', ['shard-1'], epochKey, 'image/png', {
        skipCache: true,
      });

      // Should download twice
      expect(downloadShards).toHaveBeenCalledTimes(2);
    });

    it('calls progress callback', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      let progressCallback:
        | ((loaded: number, total: number) => void)
        | undefined;

      vi.mocked(downloadShards).mockImplementation(async (_, onProgress) => {
        progressCallback = onProgress;
        onProgress?.(50, 100);
        onProgress?.(100, 100);
        return [new Uint8Array([1, 2, 3])];
      });

      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;
      const onProgress = vi.fn();

      await loadPhoto('photo-progress', ['shard-1'], epochKey, 'image/jpeg', {
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith(50, 100);
      expect(onProgress).toHaveBeenCalledWith(100, 100);
    });

    it('throws PhotoAssemblyError on decryption failure', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockRejectedValue(new Error('Decryption failed')),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      await expect(
        loadPhoto('photo-fail', ['shard-1'], epochKey, 'image/jpeg'),
      ).rejects.toThrow();
    });
  });

  describe('releasePhoto', () => {
    it('decrements reference count', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      await loadPhoto('photo-release', ['shard-1'], epochKey, 'image/jpeg');

      // Should not throw
      releasePhoto('photo-release');
      releasePhoto('photo-release'); // Can release multiple times safely
    });

    it('handles releasing non-existent photo', () => {
      // Should not throw
      releasePhoto('non-existent');
    });
  });

  describe('clearPhotoCache', () => {
    it('clears all cached photos', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      await loadPhoto('photo-clear-1', ['shard-1'], epochKey, 'image/jpeg');
      await loadPhoto('photo-clear-2', ['shard-2'], epochKey, 'image/png');

      expect(getCacheStats().entries).toBe(2);

      clearPhotoCache();

      expect(getCacheStats().entries).toBe(0);
      expect(getCacheStats().sizeBytes).toBe(0);
    });

    it('revokes all blob URLs', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      await loadPhoto('photo-revoke', ['shard-1'], epochKey, 'image/jpeg');

      expect(mockBlobUrls.size).toBe(1);

      clearPhotoCache();

      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
    });
  });

  describe('isPhotoCached', () => {
    it('returns false for uncached photos', () => {
      expect(isPhotoCached('non-existent-photo')).toBe(false);
    });

    it('returns true for cached photos', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;
      await loadPhoto('cached-photo', ['shard-1'], epochKey, 'image/jpeg');

      expect(isPhotoCached('cached-photo')).toBe(true);
    });
  });

  describe('getCachedPhoto', () => {
    it('returns null for uncached photos', () => {
      const result = getCachedPhoto('non-existent-photo');
      expect(result).toBeNull();
    });

    it('returns photo result for cached photos', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;
      const loaded = await loadPhoto('get-cached-photo', ['shard-1'], epochKey, 'image/jpeg');

      // Release the initial reference
      releasePhoto('get-cached-photo');

      // Now get from cache
      const cached = getCachedPhoto('get-cached-photo');

      expect(cached).not.toBeNull();
      expect(cached!.blobUrl).toBe(loaded.blobUrl);
      expect(cached!.size).toBe(loaded.size);
    });

    it('increments refCount when getting cached photo', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;
      await loadPhoto('refcount-photo', ['shard-1'], epochKey, 'image/jpeg');

      // Get from cache multiple times
      const cached1 = getCachedPhoto('refcount-photo');
      const cached2 = getCachedPhoto('refcount-photo');

      expect(cached1).not.toBeNull();
      expect(cached2).not.toBeNull();
      
      // Release all references - 3 total (initial load + 2 getCachedPhoto)
      releasePhoto('refcount-photo');
      releasePhoto('refcount-photo');
      releasePhoto('refcount-photo');
      
      // Photo should still be in cache (LRU eviction hasn't happened)
      expect(isPhotoCached('refcount-photo')).toBe(true);
    });
  });

  describe('getCacheStats', () => {
    it('returns empty stats initially', () => {
      const stats = getCacheStats();

      expect(stats.entries).toBe(0);
      expect(stats.sizeBytes).toBe(0);
      expect(stats.maxSizeBytes).toBeGreaterThan(0);
    });

    it('tracks cache size after loading photos', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShardWithEpoch: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = 'epoch-handle-42' as never;

      await loadPhoto('photo-stats', ['shard-1'], epochKey, 'image/jpeg');

      const stats = getCacheStats();

      expect(stats.entries).toBe(1);
      expect(stats.sizeBytes).toBeGreaterThan(0);
    });
  });
});

describe('PhotoAssemblyError', () => {
  it('creates error with photo ID and cause', () => {
    const cause = new Error('Decryption failed');
    const error = new PhotoAssemblyError('photo-123', cause);

    expect(error.photoId).toBe('photo-123');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      'Failed to assemble photo photo-123: Decryption failed',
    );
    expect(error.name).toBe('PhotoAssemblyError');
  });

  it('is instanceof Error', () => {
    const error = new PhotoAssemblyError('photo-123', new Error('test'));
    expect(error).toBeInstanceOf(Error);
  });
});

describe('Thumbnail Loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPhotoCache();
    blobUrlCounter = 0;
    mockBlobUrls.clear();

    // Mock URL methods
    globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:mock-${++blobUrlCounter}`;
      mockBlobUrls.set(url, blob);
      return url;
    });

    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      mockBlobUrls.delete(url);
    });
  });

  afterEach(() => {
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  describe('loadThumbnailFromBase64', () => {
    it('decodes base64 and returns blob URL', () => {
      // Base64 of "JPEG" (4 bytes)
      const base64 = 'SlBFRw==';

      const result = loadThumbnailFromBase64('photo-1', base64);

      expect(result.blobUrl).toMatch(/^blob:mock-/);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.size).toBe(4);
    });

    it('returns cached result on second call', () => {
      const base64 = 'SlBFRw==';

      const result1 = loadThumbnailFromBase64('photo-2', base64);
      const result2 = loadThumbnailFromBase64('photo-2', base64);

      expect(result1.blobUrl).toBe(result2.blobUrl);
      // createObjectURL should only be called once
      expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('creates separate cache entries for different photos', () => {
      const base64 = 'SlBFRw==';

      const result1 = loadThumbnailFromBase64('photo-a', base64);
      const result2 = loadThumbnailFromBase64('photo-b', base64);

      expect(result1.blobUrl).not.toBe(result2.blobUrl);
      expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(2);
    });
  });

  describe('releaseThumbnail', () => {
    it('decreases ref count without error', () => {
      const base64 = 'SlBFRw==';
      loadThumbnailFromBase64('photo-release', base64);

      // Should not throw
      expect(() => releaseThumbnail('photo-release')).not.toThrow();
    });

    it('does not throw for non-existent photo', () => {
      expect(() => releaseThumbnail('nonexistent')).not.toThrow();
    });
  });

  describe('clearThumbnailCache', () => {
    it('clears all cached thumbnails', () => {
      const base64 = 'SlBFRw==';
      loadThumbnailFromBase64('photo-clear-1', base64);
      loadThumbnailFromBase64('photo-clear-2', base64);

      clearThumbnailCache();

      const stats = getThumbnailCacheStats();
      expect(stats.entries).toBe(0);
      expect(stats.sizeBytes).toBe(0);
    });

    it('revokes blob URLs when clearing', () => {
      const base64 = 'SlBFRw==';
      loadThumbnailFromBase64('photo-revoke', base64);

      clearThumbnailCache();

      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
    });
  });

  describe('getThumbnailCacheStats', () => {
    it('returns initial empty stats', () => {
      clearThumbnailCache();
      const stats = getThumbnailCacheStats();

      expect(stats.entries).toBe(0);
      expect(stats.sizeBytes).toBe(0);
      expect(stats.maxSizeBytes).toBeGreaterThan(0);
    });

    it('tracks cache size after loading thumbnails', () => {
      const base64 = 'SlBFRw==';
      loadThumbnailFromBase64('photo-stats', base64);

      const stats = getThumbnailCacheStats();

      expect(stats.entries).toBe(1);
      expect(stats.sizeBytes).toBe(4); // "JPEG" is 4 bytes
    });
  });
});
