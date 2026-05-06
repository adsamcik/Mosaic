import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadHandlerContext, UploadTask } from '../types';

const mocks = vi.hoisted(() => ({
  generateTieredImages: vi.fn(),
  generateThumbnail: vi.fn(),
  encryptShardWithEpochHandle: vi.fn(),
  getCryptoClient: vi.fn(),
  shouldStripExifFromOriginals: vi.fn().mockReturnValue(true),
  shouldStoreOriginalsAsAvif: vi.fn().mockReturnValue(false),
  getThumbnailQualityValue: vi.fn().mockReturnValue(0.8),
  stripExifFromBlob: vi.fn(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../thumbnail-generator', () => ({
  generateTieredImages: (...args: unknown[]) => mocks.generateTieredImages(...args),
  generateThumbnail: (...args: unknown[]) => mocks.generateThumbnail(...args),
}));

vi.mock('../../crypto-client', () => ({
  getCryptoClient: () => mocks.getCryptoClient(),
}));

vi.mock('../../settings-service', () => ({
  shouldStripExifFromOriginals: () => mocks.shouldStripExifFromOriginals(),
  shouldStoreOriginalsAsAvif: () => mocks.shouldStoreOriginalsAsAvif(),
  getThumbnailQualityValue: () => mocks.getThumbnailQualityValue(),
}));

vi.mock('../../exif-stripper', () => ({
  stripExifFromBlob: (...args: unknown[]) => mocks.stripExifFromBlob(...args),
}));

import { processTieredUpload } from '../tiered-upload-handler';

function createTask(mimeType: string): UploadTask {
  return {
    id: `task-${mimeType}`,
    file: new File([new Uint8Array([1, 2, 3])], 'redacted.bin', { type: mimeType }),
    albumId: 'album-001',
    epochId: 42,
    epochHandleId: 'epoch-handle-42' as never,
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
    mocks.getCryptoClient.mockResolvedValue({
      encryptShardWithEpochHandle: mocks.encryptShardWithEpochHandle,
    });
    mocks.encryptShardWithEpochHandle.mockResolvedValue(new Uint8Array([9]));
    mocks.generateTieredImages.mockResolvedValue({
      thumbnail: { data: new Uint8Array([1]), width: 100, height: 75, tier: 1 },
      preview: { data: new Uint8Array([2]), width: 800, height: 600, tier: 2 },
      original: { data: new Uint8Array([3]), width: 1600, height: 1200, tier: 3 },
      originalWidth: 1600,
      originalHeight: 1200,
    });
    mocks.generateThumbnail.mockResolvedValue({ data: new Uint8Array([4]), thumbhash: 'thumbhash' });
  });

  it.each([
    ['image/jpeg', 'wasm-strip-failed', /metadata stripping failed/],
    ['image/jpeg', 'malformed-jpeg', /malformed image\/jpeg/],
    ['image/png', 'malformed-png', /malformed image\/png/],
    ['image/webp', 'malformed-webp', /malformed image\/webp/],
    ['image/heic', 'malformed-heic', /malformed image\/heic/],
    ['image/avif', 'malformed-avif', /malformed image\/avif/],
    ['video/mp4', 'malformed-video', /malformed video\/mp4/],
  ])('rejects %s originals when stripper reports %s before encryption or TUS upload', async (mimeType, skippedReason, messagePattern) => {
    mocks.stripExifFromBlob.mockResolvedValueOnce({ bytes: new Uint8Array([3]), stripped: false, skippedReason });
    const task = createTask(mimeType);
    const ctx = createCtx();

    await expect(processTieredUpload(task, ctx)).rejects.toThrow(messagePattern);

    expect(mocks.encryptShardWithEpochHandle).not.toHaveBeenCalled();
    expect(ctx.tusUpload).not.toHaveBeenCalled();
    expect(ctx.updatePersistedTask).not.toHaveBeenCalled();
    expect(ctx.onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['image/gif', /metadata stripping is unsupported/],
    ['image/bmp', /metadata stripping is unsupported/],
  ])('rejects preserve-original %s before tier generation when stripping is required', async (mimeType, messagePattern) => {
    const task = createTask(mimeType);
    const ctx = createCtx();

    await expect(processTieredUpload(task, ctx)).rejects.toThrow(messagePattern);

    expect(mocks.generateTieredImages).not.toHaveBeenCalled();
    expect(mocks.stripExifFromBlob).not.toHaveBeenCalled();
    expect(mocks.encryptShardWithEpochHandle).not.toHaveBeenCalled();
    expect(ctx.tusUpload).not.toHaveBeenCalled();
  });

  it('uploads canvas-generated AVIF originals without passing them through the metadata stripper', async () => {
    mocks.shouldStoreOriginalsAsAvif.mockReturnValue(true);
    const task = createTask('image/jpeg');
    const ctx = createCtx();

    await expect(processTieredUpload(task, ctx)).resolves.toBeUndefined();

    expect(mocks.stripExifFromBlob).not.toHaveBeenCalled();
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(3);
    expect(ctx.tusUpload).toHaveBeenCalledTimes(3);
    expect(ctx.updatePersistedTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: 'complete' }));
    expect(ctx.onComplete).toHaveBeenCalled();
  });
});
