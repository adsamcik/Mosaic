import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError, type CryptoPool } from '../crypto-pool';
import { executePhotoTask, type DownloadPlanEntry, type PhotoPipelineDeps } from '../coordinator/photo-pipeline';

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
    decryptShard: vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => bytes),
    decryptShardWithTierKey: vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => bytes),
    getStats: vi.fn(async () => ({ size: 2, idle: 2, busy: 0, queued: 0 })),
    shutdown: vi.fn(async (): Promise<void> => undefined),
  };
  return {
    pool,
    fetchShards: vi.fn(async (): Promise<Uint8Array[]> => [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])]),
    getEpochSeed: vi.fn(async (): Promise<Uint8Array> => new Uint8Array(32).fill(7)),
    writePhotoChunk: vi.fn(async (): Promise<void> => undefined),
    truncatePhoto: vi.fn(async (): Promise<void> => undefined),
    getPhotoFileLength: vi.fn(async (): Promise<number | null> => null),
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
    expect(deps.pool.decryptShard).toHaveBeenCalledTimes(2);
    expect(deps.writePhotoChunk).toHaveBeenCalledWith('job', 'photo-1', 0, new Uint8Array([1, 2, 3, 4, 5, 6]));
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

  it('returns Decrypt without retrying AEAD failure', async () => {
    const deps = makeDeps();
    vi.mocked(deps.pool.decryptShard).mockRejectedValue(new DownloadError('Decrypt', 'bad tag'));
    await expect(executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps))
      .resolves.toEqual({ kind: 'failed', code: 'Decrypt' });
    expect(deps.pool.decryptShard).toHaveBeenCalledTimes(1);
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
    vi.mocked(deps2.pool.decryptShard).mockImplementation(async () => {
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
});
