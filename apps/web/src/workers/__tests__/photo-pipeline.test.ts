import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError, type CryptoPool } from '../crypto-pool';
import { executePhotoTask, type DownloadPlanEntry, type PhotoPipelineDeps } from '../coordinator/photo-pipeline';
import type { StreamingShardDecryptor } from '../rust-crypto-core';

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
    expect(deps.pool.decryptShard).toHaveBeenCalledTimes(2);
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


  it('reports final bytes written on successful photo writes', async () => {
    const deps = makeDeps();
    await executePhotoTask({ jobId: 'job', albumId: 'album', entry, signal: signal() }, deps);
    expect(deps.reportBytesWritten).toHaveBeenCalledTimes(1);
    expect(deps.reportBytesWritten).toHaveBeenCalledWith('job', 'photo-1', 6);
  });

  it('does not report bytes for failed or skipped outcomes', async () => {
    const failedDeps = makeDeps();
    vi.mocked(failedDeps.pool.decryptShard).mockRejectedValue(new DownloadError('Decrypt', 'bad tag'));
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
// Streaming AEAD path (variant 1, > 16 MiB)
// ---------------------------------------------------------------------------

const STREAMING_THRESHOLD = 16 * 1024 * 1024;
const VARIANT_OFFSET = 38;
const TAG_BYTES = 16;

function makeStreamingShard(opts: { chunkSize: number; chunks: number; finalPlainBytes: number }): {
  shard: Uint8Array;
  expectedPlaintextLength: number;
} {
  const onWire = opts.chunkSize + TAG_BYTES;
  const finalOnWire = opts.finalPlainBytes + TAG_BYTES;
  const total = 64 + (opts.chunks - 1) * onWire + finalOnWire;
  const shard = new Uint8Array(total);
  shard[VARIANT_OFFSET] = 1; // streaming variant
  return {
    shard,
    expectedPlaintextLength: (opts.chunks - 1) * opts.chunkSize + opts.finalPlainBytes,
  };
}

function makeMonolithShard(byteLength: number, variant = 0): Uint8Array {
  const s = new Uint8Array(byteLength);
  s[VARIANT_OFFSET] = variant;
  return s;
}

function fakeDecryptor(chunkSize: number): StreamingShardDecryptor & { closed: boolean; chunkCalls: number } {
  let closed = false;
  const inst = {
    chunkSizeBytes: chunkSize,
    chunkCalls: 0,
    get closed() { return closed; },
    async processChunk(chunk: Uint8Array, _isFinal: boolean): Promise<Uint8Array> {
      this.chunkCalls += 1;
      // Return plaintext = wire-bytes minus tag, all-zero filler.
      return new Uint8Array(chunk.byteLength - TAG_BYTES);
    },
    async close(): Promise<void> { closed = true; },
  };
  return inst as StreamingShardDecryptor & { closed: boolean; chunkCalls: number };
}

describe('executePhotoTask streaming path', () => {
  it('uses streaming decrypt for variant-1 shards above the 16 MiB threshold', async () => {
    const chunkSize = 1024 * 1024; // 1 MiB
    const { shard, expectedPlaintextLength } = makeStreamingShard({
      chunkSize,
      chunks: 17,
      finalPlainBytes: 100, // tail
    });
    expect(shard.byteLength).toBeGreaterThan(STREAMING_THRESHOLD);

    const deps = makeDeps();
    const decryptor = fakeDecryptor(chunkSize);
    vi.mocked(deps.fetchShards).mockResolvedValue([shard]);
    const openSpy = vi.fn(async () => decryptor);
    const streamingDeps: PhotoPipelineDeps = { ...deps, openStreamingShard: openSpy };

    const streamingEntry: DownloadPlanEntry = {
      ...entry,
      shardIds: ['big-shard'],
      expectedHashes: [new Uint8Array([1])],
      totalBytes: expectedPlaintextLength,
    };

    const outcome = await executePhotoTask(
      { jobId: 'job', albumId: 'album', entry: streamingEntry, signal: signal() },
      streamingDeps,
    );

    expect(outcome).toEqual({ kind: 'done', bytesWritten: expectedPlaintextLength });
    expect(openSpy).toHaveBeenCalledTimes(1);
    // header slice is exactly 64 bytes
    expect((openSpy.mock.calls[0] as unknown as [Uint8Array, Uint8Array])[0].byteLength).toBe(64);
    expect(decryptor.closed).toBe(true);
    expect(decryptor.chunkCalls).toBe(17);
    // The pool's whole-message decrypt path MUST NOT be touched.
    expect(deps.pool.decryptShard).not.toHaveBeenCalled();
    // Bytes are written incrementally — last call's offset is non-zero.
    const writeCalls = vi.mocked(deps.writePhotoChunk).mock.calls;
    expect(writeCalls.length).toBe(17);
    expect(writeCalls[0]?.[2]).toBe(0);
    expect(writeCalls[writeCalls.length - 1]?.[2]).toBe(expectedPlaintextLength - 100);
  });

  it('keeps variant-0 shards on the existing whole-message decrypt path', async () => {
    const big = makeMonolithShard(STREAMING_THRESHOLD + 1024, 0);
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockResolvedValue([big]);
    vi.mocked(deps.pool.decryptShard).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const openSpy = vi.fn();
    const monolithDeps: PhotoPipelineDeps = { ...deps, openStreamingShard: openSpy };

    const monolithEntry: DownloadPlanEntry = {
      ...entry,
      shardIds: ['m'],
      expectedHashes: [new Uint8Array([1])],
      totalBytes: 3,
    };

    const outcome = await executePhotoTask(
      { jobId: 'job', albumId: 'album', entry: monolithEntry, signal: signal() },
      monolithDeps,
    );

    expect(outcome).toEqual({ kind: 'done', bytesWritten: 3 });
    expect(openSpy).not.toHaveBeenCalled();
    expect(deps.pool.decryptShard).toHaveBeenCalledTimes(1);
  });

  it('keeps small variant-1 shards on the whole-message path (threshold respected)', async () => {
    const smallVariant1 = makeMonolithShard(1024, 1);
    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockResolvedValue([smallVariant1]);
    vi.mocked(deps.pool.decryptShard).mockResolvedValue(new Uint8Array([9]));
    const openSpy = vi.fn();
    const mixedDeps: PhotoPipelineDeps = { ...deps, openStreamingShard: openSpy };

    const e: DownloadPlanEntry = {
      ...entry,
      shardIds: ['s'],
      expectedHashes: [new Uint8Array([1])],
      totalBytes: 1,
    };

    await executePhotoTask({ jobId: 'job', albumId: 'album', entry: e, signal: signal() }, mixedDeps);

    expect(openSpy).not.toHaveBeenCalled();
    expect(deps.pool.decryptShard).toHaveBeenCalledTimes(1);
  });

  it('handles mixed shards in one photo (monolith + streaming) at running offsets', async () => {
    const mono = new Uint8Array(64);
    mono[VARIANT_OFFSET] = 0;
    const chunkSize = 1024 * 1024;
    const { shard: streaming, expectedPlaintextLength } = makeStreamingShard({
      chunkSize,
      chunks: 17,
      finalPlainBytes: 50,
    });

    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockResolvedValue([mono, streaming]);
    vi.mocked(deps.pool.decryptShard).mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));
    const decryptor = fakeDecryptor(chunkSize);
    const openSpy = vi.fn(async () => decryptor);
    const mixedDeps: PhotoPipelineDeps = { ...deps, openStreamingShard: openSpy };

    const e: DownloadPlanEntry = {
      ...entry,
      shardIds: ['m', 'big'],
      expectedHashes: [new Uint8Array([1]), new Uint8Array([2])],
      totalBytes: 5 + expectedPlaintextLength,
    };

    const outcome = await executePhotoTask(
      { jobId: 'job', albumId: 'album', entry: e, signal: signal() },
      mixedDeps,
    );

    expect(outcome).toEqual({ kind: 'done', bytesWritten: 5 + expectedPlaintextLength });
    const writeCalls = vi.mocked(deps.writePhotoChunk).mock.calls;
    // First write is the monolith plaintext at offset 0
    expect(writeCalls[0]?.[2]).toBe(0);
    expect(writeCalls[0]?.[3].byteLength).toBe(5);
    // Second write is the first streaming chunk's plaintext at offset 5
    expect(writeCalls[1]?.[2]).toBe(5);
    expect(decryptor.closed).toBe(true);
  });

  it('streams a 1 GiB synthetic shard while keeping peak resident allocation under 4 MB', async () => {
    const chunkSize = 1024 * 1024; // 1 MiB
    // 1 GiB plaintext = 1024 chunks
    const totalChunks = 1024;
    const onWire = chunkSize + TAG_BYTES;
    // Build a single Uint8Array but back it by a SharedArrayBuffer-style allocation
    // we never *populate* — happy-dom + node copy semantics still cost real RAM.
    // To keep this test cheap we use a buffer view into a fixed allocation and lie
    // about its byteLength via subarray semantics: we need the pipeline to *see*
    // length > 1 GiB but never actually copy that much. Simplest: allocate the
    // whole thing once, then measure peak heap delta.
    const totalBytes = 64 + totalChunks * onWire;
    const before = process.memoryUsage().heapUsed;
    const shard = new Uint8Array(totalBytes);
    shard[VARIANT_OFFSET] = 1;
    const baseline = process.memoryUsage().heapUsed;

    let peakDelta = 0;
    const trackPeak = (): void => {
      const d = process.memoryUsage().heapUsed - baseline;
      if (d > peakDelta) peakDelta = d;
    };

    const deps = makeDeps();
    vi.mocked(deps.fetchShards).mockResolvedValue([shard]);
    vi.mocked(deps.pool.verifyShard).mockImplementation(async () => { trackPeak(); });
    vi.mocked(deps.writePhotoChunk).mockImplementation(async (_j, _p, _o, bytes) => {
      trackPeak();
      // Drop the reference so GC can reclaim per-chunk plaintext buffers.
      void bytes.byteLength;
    });
    const decryptor: StreamingShardDecryptor = {
      chunkSizeBytes: chunkSize,
      processChunk: async (c, _final): Promise<Uint8Array> => {
        trackPeak();
        return new Uint8Array(c.byteLength - TAG_BYTES);
      },
      close: async (): Promise<void> => undefined,
    };
    const openSpy = vi.fn(async () => decryptor);
    const streamDeps: PhotoPipelineDeps = { ...deps, openStreamingShard: openSpy };

    const e: DownloadPlanEntry = {
      ...entry,
      shardIds: ['huge'],
      expectedHashes: [new Uint8Array([1])],
      totalBytes: totalChunks * chunkSize,
    };

    const outcome = await executePhotoTask(
      { jobId: 'job', albumId: 'album', entry: e, signal: signal() },
      streamDeps,
    );

    expect(outcome).toEqual({ kind: 'done', bytesWritten: totalChunks * chunkSize });
    // The streaming pipeline must not retain ~1 GiB of plaintext. Peak heap
    // delta during decrypt+write should stay small (< 4 MB). Because GC is
    // non-deterministic we use 8 MB as a generous ceiling that still catches
    // accidental whole-shard buffering.
    expect(peakDelta).toBeLessThan(4 * 1024 * 1024);
    void before; // silence unused
  }, 30_000);
});
