import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError, type CryptoPool } from '../crypto-pool';
import { executePhotoTask, type DownloadPlanEntry, type PhotoPipelineDeps } from '../coordinator/photo-pipeline';
import type { EpochHandleId } from '../types';

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
}

const entry: DownloadPlanEntry = {
  photoId: 'photo-1',
  epochId: 7,
  tier: 3,
  shardIds: ['shard-1', 'shard-2'],
  expectedHashes: [new Uint8Array([1]), new Uint8Array([2])],
  filename: 'one.jpg',
  totalBytes: 6,
};

function makeDeps(): PhotoPipelineDeps {
  const pool: CryptoPool = {
    size: 2,
    verifyShard: vi.fn(async (): Promise<void> => undefined),
    decryptShardWithTierKey: vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => bytes),
    decryptShardWithEpochHandle: vi.fn(async (_handle, bytes: Uint8Array): Promise<Uint8Array> => bytes),
    decryptShardWithLinkTierHandle: vi.fn(async (_handle, bytes: Uint8Array): Promise<Uint8Array> => bytes),
    getStats: vi.fn(async () => ({ size: 2, idle: 2, busy: 0, queued: 0 })),
    shutdown: vi.fn(async (): Promise<void> => undefined),
  };
  return {
    pool,
    fetchShards: vi.fn(async (): Promise<Uint8Array[]> => [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])]),
    getEpochSeed: vi.fn(async () => ({ kind: 'epoch-handle' as const, handleId: 'epch_test_pipeline' as EpochHandleId })),
    writePhotoChunk: vi.fn(async (): Promise<void> => undefined),
    truncatePhoto: vi.fn(async (): Promise<void> => undefined),
    getPhotoFileLength: vi.fn(async (): Promise<number | null> => null),
    reportBytesWritten: vi.fn(),
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executePhotoTask', () => {
  it('fetches, verifies, decrypts, writes, and returns Done', async () => {
    const deps = makeDeps();
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps))
      .resolves.toEqual({ kind: 'done', bytesWritten: 6 });
    expect(deps.pool.verifyShard).toHaveBeenCalledTimes(2);
    expect(deps.pool.decryptShardWithEpochHandle).toHaveBeenCalledTimes(2);
    expect(deps.writePhotoChunk).toHaveBeenNthCalledWith(1, 'job', 'photo-1', 0, new Uint8Array([1, 2]));
    expect(deps.writePhotoChunk).toHaveBeenNthCalledWith(2, 'job', 'photo-1', 2, new Uint8Array([3, 4, 5, 6]));
    expect(deps.reportBytesWritten).toHaveBeenCalledWith('job', 'photo-1', 6);
  });

  it.each([
    [404, { kind: 'skipped', reason: 'NotFound' }],
    [401, { kind: 'failed', code: 'AuthorizationChanged' }],
    [403, { kind: 'failed', code: 'AccessRevoked' }],
  ] as const)('maps HTTP %s', async (status, expected) => {
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockRejectedValue(new HttpError(status));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps)).resolves.toMatchObject(expected);
  });

  it('retries 5xx and succeeds on the second attempt', async () => {
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockRejectedValueOnce(new HttpError(503));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps)).resolves.toMatchObject({ kind: 'done' });
    expect(deps.fetchShards).toHaveBeenCalledTimes(2);
  });

  it('returns TransientNetwork after retry budget is exceeded', async () => {
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockRejectedValue(new HttpError(503));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps))
      .resolves.toMatchObject({ kind: 'failed', code: 'TransientNetwork' });
    expect(deps.fetchShards).toHaveBeenCalledTimes(3);
  });

  it('returns Integrity after one verification retry', async () => {
    const deps = makeDeps();
    vi.mocked(deps.pool.verifyShard).mockRejectedValue(new DownloadError('Integrity', 'bad hash'));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps))
      .resolves.toEqual({ kind: 'failed', code: 'Integrity' });
    expect(deps.pool.verifyShard).toHaveBeenCalledTimes(2);
  });



  it('routes decryption through the resolved epoch handle', async () => {
    const deps = makeDeps();
    const previewEntry: DownloadPlanEntry = { ...entry, tier: 2 };
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry: previewEntry, signal: signal() }, deps))
      .resolves.toMatchObject({ kind: 'done' });
    expect(deps.pool.decryptShardWithEpochHandle).toHaveBeenCalledWith('epch_test_pipeline', expect.any(Uint8Array));
  });

  it('returns Decrypt without retrying AEAD failure', async () => {
    const deps = makeDeps();
    vi.mocked(deps.pool.decryptShardWithEpochHandle).mockRejectedValue(new DownloadError('Decrypt', 'bad tag'));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps))
      .resolves.toEqual({ kind: 'failed', code: 'Decrypt' });
    expect(deps.pool.decryptShardWithEpochHandle).toHaveBeenCalledTimes(1);
  });

  it('maps abort during fetch and decrypt to Cancelled', async () => {
    const controller = new AbortController();
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: controller.signal }, deps))
      .resolves.toEqual({ kind: 'failed', code: 'Cancelled' });

    const decryptController = new AbortController();
    const deps2 = makeDeps();
    vi.mocked(deps2.pool.decryptShardWithEpochHandle).mockImplementation(async () => {
      decryptController.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: decryptController.signal }, deps2))
      .resolves.toEqual({ kind: 'failed', code: 'Cancelled' });
  });

  it('maps quota exceeded on write', async () => {
    const deps = makeDeps();
    vi.mocked(deps.writePhotoChunk).mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps))
      .resolves.toEqual({ kind: 'failed', code: 'Quota' });
  });

  it('reconciles resume length before re-fetching', async () => {
    const deps = makeDeps();
    vi.mocked(deps.getPhotoFileLength).mockResolvedValue(20);
    await executePhotoTask({ jobId: 'job', albumId: 'album', entry, resumeFromBytes: 10, signal: signal() }, deps);
    expect(deps.truncatePhoto).toHaveBeenCalledWith('job', 'photo-1', 10);

    const deps2 = makeDeps();
    vi.mocked(deps2.getPhotoFileLength).mockResolvedValue(5);
    await executePhotoTask({ jobId: 'job', albumId: 'album', entry, resumeFromBytes: 10, signal: signal() }, deps2);
    expect(deps2.truncatePhoto).toHaveBeenCalledWith('job', 'photo-1', 0);
  });

  it('handles zero-byte originals', async () => {
    const deps = makeDeps();
    const zero: DownloadPlanEntry = { ...entry, shardIds: [], expectedHashes: [], totalBytes: 0 };
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry: zero, signal: signal() }, deps))
      .resolves.toEqual({ kind: 'done', bytesWritten: 0 });
    expect(deps.fetchShards).not.toHaveBeenCalled();
  });


  it('reports final bytes written on successful photo writes', async () => {
    const deps = makeDeps();
    await executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps);
    expect(deps.reportBytesWritten).toHaveBeenCalledTimes(1);
    expect(deps.reportBytesWritten).toHaveBeenCalledWith('job', 'photo-1', 6);
  });

  it('does not report bytes for failed or skipped outcomes', async () => {
    const failedDeps = makeDeps();
    vi.mocked(failedDeps.pool.decryptShardWithEpochHandle).mockRejectedValue(new DownloadError('Decrypt', 'bad tag'));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, failedDeps))
      .resolves.toEqual({ kind: 'failed', code: 'Decrypt' });
    expect(failedDeps.reportBytesWritten).not.toHaveBeenCalled();

    const skippedDeps = makeDeps();
    vi.mocked(skippedDeps.fetchShards).mockRejectedValue(new HttpError(404));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, skippedDeps))
      .resolves.toEqual({ kind: 'skipped', reason: 'NotFound' });
    expect(skippedDeps.reportBytesWritten).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Handle-only shard path
// ---------------------------------------------------------------------------

const VARIANT_ONE_SHARD_BYTES = 1024;

describe('executePhotoTask handle-only shard path', () => {
  it('uses whole-message handle decrypt for variant-1 shards', async () => {
    const variantOne = new Uint8Array(VARIANT_ONE_SHARD_BYTES);
    variantOne[38] = 1;
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockResolvedValue([variantOne]);
    vi.mocked(deps.pool.decryptShardWithEpochHandle).mockResolvedValue(new Uint8Array([1, 2, 3]));

    const e: DownloadPlanEntry = {
      ...entry,
      shardIds: ['large'],
      expectedHashes: [new Uint8Array([1])],
      totalBytes: 3,
    };

    const outcome = await executePhotoTask(
      { jobId: 'job', albumId: 'album', entry: e, signal: signal() },
      deps,
    );

    expect(outcome).toEqual({ kind: 'done', bytesWritten: 3 });
    expect(deps.pool.decryptShardWithEpochHandle).toHaveBeenCalledWith('epch_test_pipeline', variantOne);
    expect(deps.writePhotoChunk).toHaveBeenCalledWith('job', 'photo-1', 0, new Uint8Array([1, 2, 3]));
  });

  it('handles mixed whole-message handle decrypts at running offsets', async () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array(VARIANT_ONE_SHARD_BYTES);
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockResolvedValue([first, second]);
    vi.mocked(deps.pool.decryptShardWithEpochHandle)
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      .mockResolvedValueOnce(new Uint8Array([4, 5]));

    const e: DownloadPlanEntry = {
      ...entry,
      shardIds: ['small', 'large'],
      expectedHashes: [new Uint8Array([1]), new Uint8Array([2])],
      totalBytes: 5,
    };

    const outcome = await executePhotoTask(
      { jobId: 'job', albumId: 'album', entry: e, signal: signal() },
      deps,
    );

    expect(outcome).toEqual({ kind: 'done', bytesWritten: 5 });
    const writeCalls = vi.mocked(deps.writePhotoChunk).mock.calls;
    expect(writeCalls[0]?.[2]).toBe(0);
    expect(writeCalls[0]?.[3]).toEqual(new Uint8Array([1, 2, 3]));
    expect(writeCalls[1]?.[2]).toBe(3);
    expect(writeCalls[1]?.[3]).toEqual(new Uint8Array([4, 5]));
  });
});
