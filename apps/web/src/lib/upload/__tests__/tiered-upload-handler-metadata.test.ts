import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadHandlerContext, UploadTask } from '../types';

const mocks = vi.hoisted(() => ({
  generateTieredImages: vi.fn(),
  encryptTieredImages: vi.fn(),
  generateThumbnail: vi.fn(),
  shouldStripExifFromOriginals: vi.fn().mockReturnValue(true),
  shouldStoreOriginalsAsAvif: vi.fn().mockReturnValue(false),
  getThumbnailQualityValue: vi.fn().mockReturnValue(0.8),
  stripExifFromBlob: vi.fn(),
  deriveTierKeys: vi.fn().mockReturnValue({
    thumbKey: new Uint8Array(32).fill(1),
    previewKey: new Uint8Array(32).fill(2),
    fullKey: new Uint8Array(32).fill(3),
  }),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../thumbnail-generator', () => ({
  generateTieredImages: (...args: unknown[]) => mocks.generateTieredImages(...args),
  encryptTieredImages: (...args: unknown[]) => mocks.encryptTieredImages(...args),
  generateThumbnail: (...args: unknown[]) => mocks.generateThumbnail(...args),
}));

vi.mock('../../settings-service', () => ({
  shouldStripExifFromOriginals: () => mocks.shouldStripExifFromOriginals(),
  shouldStoreOriginalsAsAvif: () => mocks.shouldStoreOriginalsAsAvif(),
  getThumbnailQualityValue: () => mocks.getThumbnailQualityValue(),
}));

vi.mock('../../exif-stripper', () => ({
  stripExifFromBlob: (...args: unknown[]) => mocks.stripExifFromBlob(...args),
}));

vi.mock('@mosaic/crypto', () => ({
  deriveTierKeys: (...args: unknown[]) => mocks.deriveTierKeys(...args),
  ShardTier: { THUMB: 1, PREVIEW: 2, ORIGINAL: 3 },
}));

import { processTieredUpload } from '../tiered-upload-handler';

function createTask(mimeType: string): UploadTask {
  return {
    id: `task-${mimeType}`,
    file: new File([new Uint8Array([1, 2, 3])], 'redacted.bin', { type: mimeType }),
    albumId: 'album-001',
    epochId: 42,
    readKey: new Uint8Array(32).fill(0xab),
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: [],
    retryCount: 0,
    lastAttemptAt: 0,
  };
}

function createCtx(): UploadHandlerContext {
  return {
    tusUpload: vi.fn().mockResolvedValue('shard-id'),
    updatePersistedTask: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
  };
}

describe('processTieredUpload metadata stripping fail-closed behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stripExifFromBlob.mockReset();
    mocks.shouldStripExifFromOriginals.mockReturnValue(true);
    mocks.shouldStoreOriginalsAsAvif.mockReturnValue(false);
    mocks.generateTieredImages.mockResolvedValue({
      thumbnail: { data: new Uint8Array([1]), width: 100, height: 75, tier: 1 },
      preview: { data: new Uint8Array([2]), width: 800, height: 600, tier: 2 },
      original: { data: new Uint8Array([3]), width: 1600, height: 1200, tier: 3 },
      originalWidth: 1600,
      originalHeight: 1200,
    });
    mocks.encryptTieredImages.mockResolvedValue({
      originalWidth: 1600,
      originalHeight: 1200,
      thumbnail: { width: 100, height: 75, tier: 1, encrypted: { ciphertext: new Uint8Array([1]), sha256: 'sha-thumb' } },
      preview: { width: 800, height: 600, tier: 2, encrypted: { ciphertext: new Uint8Array([2]), sha256: 'sha-preview' } },
      original: { width: 1600, height: 1200, tier: 3, encrypted: { ciphertext: new Uint8Array([3]), sha256: 'sha-original' } },
    });
    mocks.generateThumbnail.mockResolvedValue({ data: new Uint8Array([4]), thumbhash: 'thumbhash' });
  });

  it.each([
    ['image/jpeg', 'wasm-strip-failed', /metadata stripping failed/],
    ['image/jpeg', 'malformed-jpeg', /malformed image\/jpeg/],
    ['image/png', 'malformed-png', /malformed image\/png/],
    ['image/webp', 'malformed-webp', /malformed image\/webp/],
  ])('rejects %s originals when stripper reports %s before encryption or TUS upload', async (mimeType, skippedReason, messagePattern) => {
    mocks.stripExifFromBlob.mockResolvedValueOnce({ bytes: new Uint8Array([3]), stripped: false, skippedReason });
    const task = createTask(mimeType);
    const ctx = createCtx();

    await expect(processTieredUpload(task, ctx)).rejects.toThrow(messagePattern);

    expect(mocks.encryptTieredImages).not.toHaveBeenCalled();
    expect(ctx.tusUpload).not.toHaveBeenCalled();
    expect(ctx.updatePersistedTask).not.toHaveBeenCalled();
    expect(ctx.onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['image/heic', /R-M1/],
    ['image/avif', /R-M2/],
    ['video/mp4', /R-M6/],
    ['image/gif', /metadata stripping is unsupported/],
    ['image/bmp', /metadata stripping is unsupported/],
  ])('rejects preserve-original %s before tier generation when stripping is required', async (mimeType, messagePattern) => {
    const task = createTask(mimeType);
    const ctx = createCtx();

    await expect(processTieredUpload(task, ctx)).rejects.toThrow(messagePattern);

    expect(mocks.generateTieredImages).not.toHaveBeenCalled();
    expect(mocks.stripExifFromBlob).not.toHaveBeenCalled();
    expect(mocks.encryptTieredImages).not.toHaveBeenCalled();
    expect(ctx.tusUpload).not.toHaveBeenCalled();
  });

  it('uploads canvas-generated AVIF originals without passing them through the metadata stripper', async () => {
    mocks.shouldStoreOriginalsAsAvif.mockReturnValue(true);
    const task = createTask('image/jpeg');
    const ctx = createCtx();

    await expect(processTieredUpload(task, ctx)).resolves.toBeUndefined();

    expect(mocks.stripExifFromBlob).not.toHaveBeenCalled();
    expect(mocks.encryptTieredImages).toHaveBeenCalled();
    expect(ctx.tusUpload).toHaveBeenCalledTimes(3);
    expect(ctx.updatePersistedTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'complete' }));
    expect(ctx.onComplete).toHaveBeenCalled();
  });
});
