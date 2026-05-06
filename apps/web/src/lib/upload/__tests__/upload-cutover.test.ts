import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadHandlerContext, UploadTask } from '../types';
import type { EpochHandleId } from '../../../workers/types';

const mocks = vi.hoisted(() => ({
  generateTieredImages: vi.fn(),
  generateThumbnail: vi.fn(),
  extractVideoFrame: vi.fn(),
  getCryptoClient: vi.fn(),
  encryptShardWithEpochHandle: vi.fn(),
  encryptShardWithEpoch: vi.fn(),
  shouldStripExifFromOriginals: vi.fn().mockReturnValue(false),
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

vi.mock('../../video-frame-extractor', () => ({
  extractVideoFrame: (...args: unknown[]) => mocks.extractVideoFrame(...args),
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

import { processLegacyUpload } from '../legacy-upload-handler';
import { processTieredUpload } from '../tiered-upload-handler';
import { processVideoUpload } from '../video-upload-handler';

const EPOCH_HANDLE = 'epch_upload-cutover' as EpochHandleId;

function createTask(file: File): UploadTask {
  return {
    id: 'task-upload-cutover',
    file,
    albumId: 'album-001',
    epochId: 42,
    epochHandleId: EPOCH_HANDLE,
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

describe('upload encryption handle cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldStripExifFromOriginals.mockReturnValue(false);
    mocks.shouldStoreOriginalsAsAvif.mockReturnValue(false);
    mocks.getCryptoClient.mockResolvedValue({
      encryptShardWithEpochHandle: mocks.encryptShardWithEpochHandle,
      encryptShardWithEpoch: mocks.encryptShardWithEpoch,
    });
    mocks.encryptShardWithEpochHandle.mockImplementation(
      async (_handle: EpochHandleId, _plaintext: Uint8Array, tier: number, shardIndex: number) =>
        new Uint8Array([tier, shardIndex, 99]),
    );
    mocks.generateThumbnail.mockResolvedValue({ data: new Uint8Array([4]), thumbhash: 'thumbhash' });
    mocks.generateTieredImages.mockResolvedValue({
      thumbnail: { data: new Uint8Array([1]), width: 100, height: 75, tier: 1 },
      preview: { data: new Uint8Array([2]), width: 800, height: 600, tier: 2 },
      original: { data: new Uint8Array([3]), width: 1600, height: 1200, tier: 3 },
      originalWidth: 1600,
      originalHeight: 1200,
    });
    mocks.extractVideoFrame.mockResolvedValue({
      metadata: { duration: 5, width: 1920, height: 1080, codec: 'h264' },
      thumbnailBlob: new Blob([new Uint8Array([7, 8])], { type: 'image/jpeg' }),
      embeddedThumbnail: 'data:image/jpeg;base64,AA==',
      embeddedWidth: 256,
      embeddedHeight: 144,
      thumbhash: 'thumbhash',
    });
  });

  it('uses encryptShardWithEpochHandle for image thumbnail, preview, and original tiers', async () => {
    const task = createTask(new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
    const ctx = createCtx();

    await processTieredUpload(task, ctx);

    expect(mocks.encryptShardWithEpoch).not.toHaveBeenCalled();
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(3);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(1, EPOCH_HANDLE, new Uint8Array([1]), 1, 0);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(2, EPOCH_HANDLE, new Uint8Array([2]), 2, 0);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(3, EPOCH_HANDLE, new Uint8Array([3]), 3, 0);
    expect(ctx.tusUpload).toHaveBeenCalledTimes(3);
  });

  it('uses encryptShardWithEpochHandle for legacy original chunks', async () => {
    const task = createTask(new File([new Uint8Array([9, 8, 7])], 'data.bin', { type: 'application/octet-stream' }));
    const ctx = createCtx();
    const crypto = await mocks.getCryptoClient();

    await processLegacyUpload(task, crypto, ctx);

    expect(mocks.encryptShardWithEpoch).not.toHaveBeenCalled();
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(1);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledWith(EPOCH_HANDLE, new Uint8Array([9, 8, 7]), 3, 0);
    expect(ctx.tusUpload).toHaveBeenCalledTimes(1);
  });

  it('uses encryptShardWithEpochHandle for video thumbnail and original chunks', async () => {
    const task = createTask(new File([new Uint8Array([5, 6, 7])], 'clip.mp4', { type: 'video/mp4' }));
    const ctx = createCtx();

    await processVideoUpload(task, ctx);

    expect(mocks.encryptShardWithEpoch).not.toHaveBeenCalled();
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(2);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(1, EPOCH_HANDLE, new Uint8Array([7, 8]), 1, 0);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(2, EPOCH_HANDLE, new Uint8Array([5, 6, 7]), 3, 0);
    expect(ctx.tusUpload).toHaveBeenCalledTimes(2);
  });

  it('keeps video uploads on thumb plus original tiers when no preview tier exists', async () => {
    const task = createTask(new File([new Uint8Array([5, 6, 7])], 'clip.mp4', { type: 'video/mp4' }));
    const ctx = createCtx();

    await processVideoUpload(task, ctx);

    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(2);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(1, EPOCH_HANDLE, new Uint8Array([7, 8]), 1, 0);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenNthCalledWith(2, EPOCH_HANDLE, new Uint8Array([5, 6, 7]), 3, 0);
    expect(mocks.encryptShardWithEpochHandle).not.toHaveBeenCalledWith(EPOCH_HANDLE, expect.any(Uint8Array), 2, expect.any(Number));
    expect(task.completedShards.map((shard) => shard.tier)).toEqual([1, 3]);
    expect(task.tieredShards?.preview).toEqual(task.tieredShards?.thumbnail);
  });

  it('fails invalid video containers gracefully through the legacy video fallback', async () => {
    mocks.extractVideoFrame.mockRejectedValueOnce(new Error('invalid video container'));
    const task = createTask(new File([new Uint8Array([0, 1, 2, 3])], 'broken.mp4', { type: 'video/mp4' }));
    const ctx = createCtx();

    await processVideoUpload(task, ctx);

    expect(task.videoMetadata).toEqual({
      isVideo: true,
      duration: 0,
      width: 0,
      height: 0,
    });
    expect(mocks.encryptShardWithEpoch).not.toHaveBeenCalled();
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(1);
    expect(ctx.onComplete).toHaveBeenCalledWith(task, ['shard-id']);
  });

  it('streams very large video originals through bounded slices', async () => {
    const size = 501 * 1024 * 1024;
    const slices: Array<[number, number]> = [];
    const largeVideo = {
      name: 'large.mp4',
      type: 'video/mp4',
      size,
      slice(start: number, end: number) {
        slices.push([start, end]);
        return new Blob([new Uint8Array([start / (6 * 1024 * 1024)])], { type: 'video/mp4' });
      },
    } as unknown as File;
    const task = createTask(largeVideo);
    const ctx = createCtx();

    await processVideoUpload(task, ctx);

    const expectedChunks = Math.ceil(size / (6 * 1024 * 1024));
    expect(slices).toHaveLength(expectedChunks);
    expect(slices[0]).toEqual([0, 6 * 1024 * 1024]);
    expect(slices.at(-1)?.[1]).toBe(size);
    expect(mocks.encryptShardWithEpochHandle).toHaveBeenCalledTimes(expectedChunks + 1);
    expect(task.completedShards.filter((shard) => shard.tier === 3)).toHaveLength(expectedChunks);
  });
});
