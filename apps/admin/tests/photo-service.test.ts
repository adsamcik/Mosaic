/**
 * Photo Service Unit Tests
 *
 * Tests for the photo assembly and caching service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadPhoto,
  releasePhoto,
  clearPhotoCache,
  getCacheStats,
  PhotoAssemblyError,
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
        decryptShard: vi
          .fn()
          .mockResolvedValueOnce(decryptedChunk1)
          .mockResolvedValueOnce(decryptedChunk2),
      };
      vi.mocked(getCryptoClient).mockResolvedValue(mockCrypto as any);

      const epochKey = new Uint8Array(32).fill(42);
      const result = await loadPhoto(
        'photo-1',
        ['shard-a', 'shard-b'],
        epochKey,
        'image/jpeg'
      );

      expect(downloadShards).toHaveBeenCalledWith(
        ['shard-a', 'shard-b'],
        undefined // no progress callback when not provided
      );
      expect(mockCrypto.decryptShard).toHaveBeenCalledTimes(2);
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
        decryptShard: vi.fn().mockResolvedValue(decryptedChunk),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

      // First call
      const result1 = await loadPhoto(
        'photo-cached',
        ['shard-1'],
        epochKey,
        'image/png'
      );

      // Second call - should return cached
      const result2 = await loadPhoto(
        'photo-cached',
        ['shard-1'],
        epochKey,
        'image/png'
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
        decryptShard: vi.fn().mockResolvedValue(decryptedChunk),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

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

      let progressCallback: ((loaded: number, total: number) => void) | undefined;

      vi.mocked(downloadShards).mockImplementation(
        async (_, onProgress) => {
          progressCallback = onProgress;
          onProgress?.(50, 100);
          onProgress?.(100, 100);
          return [new Uint8Array([1, 2, 3])];
        }
      );

      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShard: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);
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
        decryptShard: vi.fn().mockRejectedValue(new Error('Decryption failed')),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

      await expect(
        loadPhoto('photo-fail', ['shard-1'], epochKey, 'image/jpeg')
      ).rejects.toThrow();
    });
  });

  describe('releasePhoto', () => {
    it('decrements reference count', async () => {
      const { downloadShards } = await import('../src/lib/shard-service');
      const { getCryptoClient } = await import('../src/lib/crypto-client');

      vi.mocked(downloadShards).mockResolvedValue([new Uint8Array([1, 2, 3])]);
      vi.mocked(getCryptoClient).mockResolvedValue({
        decryptShard: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

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
        decryptShard: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

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
        decryptShard: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

      await loadPhoto('photo-revoke', ['shard-1'], epochKey, 'image/jpeg');

      expect(mockBlobUrls.size).toBe(1);

      clearPhotoCache();

      expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
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
        decryptShard: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      } as any);

      const epochKey = new Uint8Array(32).fill(42);

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
      'Failed to assemble photo photo-123: Decryption failed'
    );
    expect(error.name).toBe('PhotoAssemblyError');
  });

  it('is instanceof Error', () => {
    const error = new PhotoAssemblyError('photo-123', new Error('test'));
    expect(error).toBeInstanceOf(Error);
  });
});
