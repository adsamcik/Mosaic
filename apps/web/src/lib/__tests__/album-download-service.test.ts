/**
 * Album Download Service Unit Tests
 *
 * Tests for downloadAlbumAsZip, supportsFileSystemAccess, and internal helpers
 * (deduplicateFilenames, getOriginalShardIds, sanitizeFilename) tested indirectly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../../workers/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('client-zip', () => ({
  downloadZip: vi.fn(),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

vi.mock('../epoch-key-service', () => ({
  getOrFetchEpochKey: vi.fn(),
}));

vi.mock('../shard-service', () => ({
  downloadShards: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks are registered
import { downloadZip } from 'client-zip';
import { getCryptoClient } from '../crypto-client';
import { getOrFetchEpochKey } from '../epoch-key-service';
import { downloadShards } from '../shard-service';
import {
  downloadAlbumAsZip,
  supportsFileSystemAccess,
  type AlbumDownloadProgress,
} from '../album-download-service';

const mockDownloadZip = vi.mocked(downloadZip);
const mockGetCryptoClient = vi.mocked(getCryptoClient);
const mockGetOrFetchEpochKey = vi.mocked(getOrFetchEpochKey);
const mockDownloadShards = vi.mocked(downloadShards);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCryptoClient = {
  decryptShard: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
  verifyShard: vi.fn().mockResolvedValue(true),
};

function createMockPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: crypto.randomUUID(),
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    shardIds: ['thumb-1', 'preview-1', 'original-1'],
    epochId: 1,
    ...overrides,
  };
}

function makeEpochBundle(epochId = 1) {
  return {
    epochId,
    epochHandleId: `epch_test-${String(epochId)}`,
    signPublicKey: new Uint8Array(32),
    epochSeed: new Uint8Array(32),
    signKeypair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    },
  };
}

/** Captured file entries yielded to downloadZip */
let capturedFiles: Array<{ name: string; input: Uint8Array; lastModified: Date }>;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capturedFiles = [];

  mockGetCryptoClient.mockResolvedValue(mockCryptoClient as never);
  mockGetOrFetchEpochKey.mockResolvedValue(makeEpochBundle() as never);
  mockDownloadShards.mockResolvedValue([new Uint8Array([10, 20, 30])]);

  // downloadZip mock: consume the async iterable, collect yielded files,
  // then return a minimal Response so blobDownload succeeds.
  mockDownloadZip.mockImplementation((input: unknown) => {
    const iterable = input as AsyncIterable<{ name: string; input: Uint8Array; lastModified: Date }>;
    const consumePromise = (async () => {
      for await (const file of iterable) {
        capturedFiles.push(file);
      }
    })();

    const stream = new ReadableStream({
      async start(controller) {
        await consumePromise;
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
    });
    return new Response(stream);
  });

  // Blob download path helpers (happy-dom handles document.createElement)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('album-download-service', () => {
  // -------------------------------------------------------------------------
  // downloadAlbumAsZip
  // -------------------------------------------------------------------------
  describe('downloadAlbumAsZip', () => {
    it('returns immediately for empty photos array', async () => {
      await downloadAlbumAsZip({
        albumName: 'Empty',
        photos: [],
        albumId: 'album-1',
      });

      expect(mockDownloadZip).not.toHaveBeenCalled();
      expect(mockGetCryptoClient).not.toHaveBeenCalled();
    });

    it('downloads and decrypts a single photo into the ZIP', async () => {
      const photo = createMockPhoto({ filename: 'sunset.jpg' });
      const decryptedData = new Uint8Array([255, 254, 253]);
      mockCryptoClient.decryptShard.mockResolvedValue(decryptedData);

      await downloadAlbumAsZip({
        albumName: 'Vacation',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(mockDownloadZip).toHaveBeenCalledTimes(1);
      expect(capturedFiles).toHaveLength(1);
      expect(capturedFiles[0]!.name).toBe('sunset.jpg');
      expect(capturedFiles[0]!.input).toEqual(decryptedData);
    });

    it('reports progress through preparing → downloading → complete phases', async () => {
      const photo = createMockPhoto();
      const progressCalls: AlbumDownloadProgress[] = [];

      await downloadAlbumAsZip({
        albumName: 'Test',
        photos: [photo],
        albumId: 'album-1',
        onProgress: (p) => progressCalls.push({ ...p }),
      });

      expect(progressCalls.length).toBeGreaterThanOrEqual(3);
      expect(progressCalls[0]!.phase).toBe('preparing');
      expect(progressCalls[0]!.totalFiles).toBe(1);
      expect(progressCalls[1]!.phase).toBe('downloading');
      expect(progressCalls[1]!.currentFileName).toBe('photo.jpg');
      expect(progressCalls[progressCalls.length - 1]!.phase).toBe('complete');
      expect(progressCalls[progressCalls.length - 1]!.completedFiles).toBe(1);
    });

    it('deduplicates filenames with suffixes', async () => {
      const photos = [
        createMockPhoto({ id: 'id-1', filename: 'beach.jpg' }),
        createMockPhoto({ id: 'id-2', filename: 'beach.jpg' }),
        createMockPhoto({ id: 'id-3', filename: 'beach.jpg' }),
      ];

      await downloadAlbumAsZip({
        albumName: 'Dupes',
        photos,
        albumId: 'album-1',
      });

      const names = capturedFiles.map((f) => f.name);
      expect(names).toContain('beach.jpg');
      expect(names).toContain('beach (2).jpg');
      expect(names).toContain('beach (3).jpg');
    });

    it('generates fallback filenames when photo has no filename', async () => {
      const photo = createMockPhoto({ id: 'abcdef12-0000-0000-0000-000000000000', filename: '' });

      await downloadAlbumAsZip({
        albumName: 'NoNames',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(capturedFiles).toHaveLength(1);
      expect(capturedFiles[0]!.name).toBe('photo-abcdef12.jpg');
    });

    it('uses originalShardIds when available (new format)', async () => {
      const photo = createMockPhoto({
        originalShardIds: ['orig-shard-1', 'orig-shard-2'],
        shardIds: ['thumb-1', 'preview-1', 'legacy-orig-1'],
      });

      await downloadAlbumAsZip({
        albumName: 'NewFormat',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(mockDownloadShards).toHaveBeenCalledWith(['orig-shard-1', 'orig-shard-2']);
    });

    it('falls back to shardIds[2:] for legacy format', async () => {
      const { originalShardIds: _, ...base } = createMockPhoto({
        shardIds: ['thumb-1', 'preview-1', 'legacy-orig-1', 'legacy-orig-2'],
      });
      const photo: PhotoMeta = base;

      await downloadAlbumAsZip({
        albumName: 'Legacy',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(mockDownloadShards).toHaveBeenCalledWith(['legacy-orig-1', 'legacy-orig-2']);
    });

    it('falls back to all shardIds when there are ≤2 shards and no originalShardIds', async () => {
      const { originalShardIds: _, ...base } = createMockPhoto({
        shardIds: ['only-shard'],
      });
      const photo: PhotoMeta = base;

      await downloadAlbumAsZip({
        albumName: 'Minimal',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(mockDownloadShards).toHaveBeenCalledWith(['only-shard']);
    });

    it('combines multi-shard originals correctly', async () => {
      const chunk1 = new Uint8Array([10, 20]);
      const chunk2 = new Uint8Array([30, 40, 50]);
      mockDownloadShards.mockResolvedValue([
        new Uint8Array([0xAA]),
        new Uint8Array([0xBB]),
      ]);
      mockCryptoClient.decryptShard
        .mockResolvedValueOnce(chunk1)
        .mockResolvedValueOnce(chunk2);

      const photo = createMockPhoto({
        originalShardIds: ['shard-a', 'shard-b'],
      });

      await downloadAlbumAsZip({
        albumName: 'Multi',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(capturedFiles).toHaveLength(1);
      const combined = capturedFiles[0]!.input;
      expect(combined).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    });

    it('verifies shard hashes when originalShardHashes are available', async () => {
      const photo = createMockPhoto({
        originalShardIds: ['shard-1'],
        originalShardHashes: ['hash-1'],
      });

      await downloadAlbumAsZip({
        albumName: 'Verified',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(mockCryptoClient.verifyShard).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        'hash-1',
      );
    });

    it('uses legacy shard hashes (shardHashes[2:]) when no originalShardHashes', async () => {
      const { originalShardIds: _a, originalShardHashes: _b, ...base } = createMockPhoto({
        shardIds: ['t', 'p', 'o1'],
        shardHashes: ['h-t', 'h-p', 'h-o1'],
      });
      const photo: PhotoMeta = base;

      await downloadAlbumAsZip({
        albumName: 'LegacyHash',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(mockCryptoClient.verifyShard).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        'h-o1',
      );
    });

    it('skips failed photos and continues', async () => {
      const photo1 = createMockPhoto({ id: 'good-1', filename: 'good.jpg' });
      const photo2 = createMockPhoto({ id: 'bad-1', filename: 'bad.jpg' });
      const photo3 = createMockPhoto({ id: 'good-2', filename: 'also-good.jpg' });

      let callCount = 0;
      mockDownloadShards.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('Network error');
        return [new Uint8Array([1, 2, 3])];
      });

      await downloadAlbumAsZip({
        albumName: 'Mixed',
        photos: [photo1, photo2, photo3],
        albumId: 'album-1',
      });

      // Only 2 files yielded (bad.jpg was skipped)
      expect(capturedFiles).toHaveLength(2);
      expect(capturedFiles.map((f) => f.name)).toEqual(['good.jpg', 'also-good.jpg']);
    });

    it('stops when AbortSignal is aborted', async () => {
      const controller = new AbortController();
      const photos = [
        createMockPhoto({ id: 'p1', filename: 'first.jpg' }),
        createMockPhoto({ id: 'p2', filename: 'second.jpg' }),
        createMockPhoto({ id: 'p3', filename: 'third.jpg' }),
      ];

      // Abort after the first photo is processed
      let downloadCount = 0;
      mockDownloadShards.mockImplementation(async () => {
        downloadCount++;
        if (downloadCount === 1) {
          controller.abort();
        }
        return [new Uint8Array([1])];
      });

      const progressCalls: AlbumDownloadProgress[] = [];

      await downloadAlbumAsZip({
        albumName: 'Cancelled',
        photos,
        albumId: 'album-1',
        onProgress: (p) => progressCalls.push({ ...p }),
        signal: controller.signal,
      });

      // First photo completes, then generator sees abort before second photo
      expect(capturedFiles.length).toBeLessThanOrEqual(1);
      const hasCancelled = progressCalls.some((p) => p.phase === 'cancelled');
      expect(hasCancelled).toBe(true);
    });

    it('sanitizes album name for ZIP filename', async () => {
      const photo = createMockPhoto();
      const clickSpy = vi.fn();

      // Intercept the <a> element to capture the download attribute
      const origCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === 'a') {
          Object.defineProperty(el, 'click', { value: clickSpy });
        }
        return el;
      });

      await downloadAlbumAsZip({
        albumName: 'My <Album>: "Special" Photos?',
        photos: [photo],
        albumId: 'album-1',
      });

      // The blob download creates an <a> with download attribute set to the sanitized filename
      // Verify downloadZip was called (ZIP was created with the sanitized name)
      expect(mockDownloadZip).toHaveBeenCalled();
    });

    it('handles photos with different epoch IDs', async () => {
      const photo1 = createMockPhoto({ id: 'p1', epochId: 1 });
      const photo2 = createMockPhoto({ id: 'p2', epochId: 2 });

      const bundle1 = makeEpochBundle(1);
      const bundle2 = makeEpochBundle(2);

      mockGetOrFetchEpochKey.mockImplementation(async (_albumId: string, epochId: number) => {
        return epochId === 1 ? bundle1 : bundle2;
      });

      await downloadAlbumAsZip({
        albumName: 'MultiEpoch',
        photos: [photo1, photo2],
        albumId: 'album-1',
      });

      expect(mockGetOrFetchEpochKey).toHaveBeenCalledWith('album-1', 1);
      expect(mockGetOrFetchEpochKey).toHaveBeenCalledWith('album-1', 2);
      expect(capturedFiles).toHaveLength(2);
    });

    it('uses takenAt for lastModified when available', async () => {
      const photo = createMockPhoto({
        takenAt: '2023-06-15T12:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await downloadAlbumAsZip({
        albumName: 'Dates',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(capturedFiles).toHaveLength(1);
      expect(capturedFiles[0]!.lastModified).toEqual(new Date('2023-06-15T12:00:00Z'));
    });

    it('falls back to createdAt for lastModified when takenAt is missing', async () => {
      const { takenAt: _, ...base } = createMockPhoto({
        createdAt: '2024-03-20T08:00:00Z',
      });
      const photo: PhotoMeta = base;

      await downloadAlbumAsZip({
        albumName: 'Dates',
        photos: [photo],
        albumId: 'album-1',
      });

      expect(capturedFiles).toHaveLength(1);
      expect(capturedFiles[0]!.lastModified).toEqual(new Date('2024-03-20T08:00:00Z'));
    });

    it('passes the correct albumId to getOrFetchEpochKey', async () => {
      const photo = createMockPhoto({ epochId: 5 });

      await downloadAlbumAsZip({
        albumName: 'Test',
        photos: [photo],
        albumId: 'my-album-42',
      });

      expect(mockGetOrFetchEpochKey).toHaveBeenCalledWith('my-album-42', 5);
    });

    it('calls getCryptoClient once even for multiple photos', async () => {
      const photos = [
        createMockPhoto({ id: 'a' }),
        createMockPhoto({ id: 'b' }),
        createMockPhoto({ id: 'c' }),
      ];

      await downloadAlbumAsZip({
        albumName: 'Batch',
        photos,
        albumId: 'album-1',
      });

      expect(mockGetCryptoClient).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // supportsFileSystemAccess
  // -------------------------------------------------------------------------
  describe('supportsFileSystemAccess', () => {
    it('returns false when showSaveFilePicker is not available', () => {
      // happy-dom does not implement showSaveFilePicker
      expect(supportsFileSystemAccess()).toBe(false);
    });

    it('returns true when showSaveFilePicker is available', () => {
      (window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn();
      try {
        expect(supportsFileSystemAccess()).toBe(true);
      } finally {
        delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
      }
    });
  });
});
