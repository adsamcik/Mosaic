import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render } from '../../components/Download/__tests__/DownloadTestUtils';
import type { CoordinatorWorkerApi, JobProgressEvent, PhotoMeta } from '../../workers/types';

const downloadAlbumAsZipMock = vi.hoisted(() => vi.fn(async (_opts: unknown): Promise<void> => undefined));
vi.mock('../../lib/album-download-service', () => ({
  downloadAlbumAsZip: downloadAlbumAsZipMock,
  supportsFileSystemAccess: () => true,
}));
vi.mock('../../lib/save-target-bridge', () => ({
  defaultSaveTargetProvider: vi.fn(),
}));
vi.mock('../../lib/epoch-key-service', () => ({
  EpochKeyErrorCode: {
    FETCH_FAILED: 'FETCH_FAILED',
    NO_KEYS_AVAILABLE: 'NO_KEYS_AVAILABLE',
    IDENTITY_NOT_DERIVED: 'IDENTITY_NOT_DERIVED',
    SIGNATURE_INVALID: 'SIGNATURE_INVALID',
    DECRYPTION_FAILED: 'DECRYPTION_FAILED',
    CONTEXT_MISMATCH: 'CONTEXT_MISMATCH',
  },
  EpochKeyError: class EpochKeyError extends Error {
    constructor(public readonly code: string, message?: string) {
      super(message ?? code);
      this.name = 'EpochKeyError';
    }
  },
  getOrFetchEpochKey: vi.fn(async () => ({ epochSeed: new Uint8Array(32), epochHandleId: 'h1' })),
}));
vi.mock('../useWakeLock', () => ({
  useWakeLock: () => ({ acquire: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }),
}));
vi.mock('comlink', () => ({ proxy: <T,>(value: T): T => value, transferHandlers: new Map() }));

interface ManagerStub {
  api: CoordinatorWorkerApi | null;
  cancelJob: ReturnType<typeof vi.fn>;
}
let managerStub: ManagerStub;
vi.mock('../useDownloadManager', () => ({
  useDownloadManager: (): unknown => managerStub,
}));

import { useAlbumDownload } from '../useAlbumDownload';

const photos: PhotoMeta[] = [{
  id: 'p1', assetId: 'a1', albumId: 'alb', filename: 'one.jpg',
  mimeType: 'image/jpeg', width: 1, height: 1, tags: [],
  createdAt: '2025-01-01', updatedAt: '2025-01-01',
  shardIds: [], originalShardIds: ['ab'.repeat(16)], epochId: 1,
}];

function makeApi(): { api: CoordinatorWorkerApi; subscribers: Map<string, (e: JobProgressEvent) => void>; startJob: ReturnType<typeof vi.fn> } {
  const subscribers = new Map<string, (e: JobProgressEvent) => void>();
  const startJob = vi.fn(async () => ({ jobId: 'job-1' }));
  const api: Partial<CoordinatorWorkerApi> = {
    startJob: startJob as unknown as CoordinatorWorkerApi['startJob'],
    subscribe: vi.fn(async (jobId: string, cb: (e: JobProgressEvent) => void) => {
      subscribers.set(jobId, cb);
      return { unsubscribe: () => subscribers.delete(jobId) };
    }) as unknown as CoordinatorWorkerApi['subscribe'],
    setSaveTargetProvider: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => ({ phase: 'Cancelled' as const })),
  };
  return { api: api as CoordinatorWorkerApi, subscribers, startJob };
}

interface HarnessProps {
  readonly onResult: (result: ReturnType<typeof useAlbumDownload>) => void;
}
function Harness(props: HarnessProps): null {
  const result = useAlbumDownload();
  // Capture latest result on each render without re-triggering renders.
  props.onResult(result);
  return null;
}

beforeEach(() => {
  downloadAlbumAsZipMock.mockClear();
  managerStub = { api: null, cancelJob: vi.fn() };
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('useAlbumDownload', () => {
  it('routes share-link viewers (resolver injected) through the legacy flow', async () => {
    let latest: ReturnType<typeof useAlbumDownload> | null = null;
    const r = await render(<Harness onResult={(res) => { latest = res; }} />);
    const resolver = vi.fn(async () => new Uint8Array(8));
    await act(async () => {
      await latest!.startDownload('alb', 'My Album', photos, { resolveOriginal: resolver });
    });
    expect(downloadAlbumAsZipMock).toHaveBeenCalledTimes(1);
    expect((downloadAlbumAsZipMock.mock.calls[0] as unknown as readonly [Record<string, unknown>])[0]).toMatchObject({ albumId: 'alb', albumName: 'My Album' });
    await r.unmount();
  });

  it('falls back to the legacy flow when no manager api is available (back-compat)', async () => {
    let latest: ReturnType<typeof useAlbumDownload> | null = null;
    const r = await render(<Harness onResult={(res) => { latest = res; }} />);
    await act(async () => {
      await latest!.startDownload('alb', 'My Album', photos);
    });
    // No manager and no resolver -> legacy path is invoked with default resolver.
    expect(downloadAlbumAsZipMock).toHaveBeenCalledTimes(1);
    expect(latest!.error).toBeNull();
    await r.unmount();
  });

  it('drives the coordinator (startJob + subscribe) when no resolver is given', async () => {
    const stub = makeApi();
    managerStub = { api: stub.api, cancelJob: vi.fn() };
    let latest: ReturnType<typeof useAlbumDownload> | null = null;
    const r = await render(<Harness onResult={(res) => { latest = res; }} />);
    let startPromise: Promise<void>;
    await act(async () => {
      startPromise = latest!.startDownload('alb', 'My Album', photos, { mode: { kind: 'zip', fileName: 'a.zip' } });
    });
    expect(stub.startJob).toHaveBeenCalledTimes(1);
    const args = stub.startJob.mock.calls[0]?.[0] as { albumId: string; outputMode: { kind: string; fileName?: string } };
    expect(args.albumId).toBe('alb');
    expect(args.outputMode).toEqual({ kind: 'zip', fileName: 'a.zip' });

    // Simulate Done from worker.
    await act(async () => {
      const cb = stub.subscribers.get('job-1');
      cb?.({ jobId: 'job-1', phase: 'Done', photoCounts: { pending: 0, inflight: 0, done: 1, failed: 0, skipped: 0 }, failureCount: 0, lastUpdatedAtMs: 0 });
      await startPromise!;
    });
    expect(downloadAlbumAsZipMock).not.toHaveBeenCalled();
    expect(latest!.error).toBeNull();
    await r.unmount();
  });

  it('cancel() aborts and cancels the running coordinator job', async () => {
    const stub = makeApi();
    const cancelJob = vi.fn(async () => ({ phase: 'Cancelled' }));
    managerStub = { api: stub.api, cancelJob };
    let latest: ReturnType<typeof useAlbumDownload> | null = null;
    const r = await render(<Harness onResult={(res) => { latest = res; }} />);
    let startPromise: Promise<void>;
    await act(async () => {
      startPromise = latest!.startDownload('alb', 'My Album', photos, { mode: { kind: 'keepOffline' } });
    });
    await act(async () => {
      latest!.cancel();
      await startPromise!.catch(() => undefined);
    });
    expect(cancelJob).toHaveBeenCalledWith('job-1', { soft: false });
    await r.unmount();
  });

  // v1.0.2 `v102-corrupt-shard-hash-error-message`: manifest-corruption
  // signals from the integrity check (`CorruptShardHashError`,
  // `CorruptShardManifest`, `ShardIntegrityMismatchError`) used to be
  // flattened into the generic "Failed to download album" string by
  // `toSafeErrorMessage`, hiding the actionable distinction. Surface a
  // specific category-level message instead.
  describe('manifest-corruption error mapping', () => {
    async function arrangeRunningJob(): Promise<{
      latest: () => ReturnType<typeof useAlbumDownload>;
      stub: ReturnType<typeof makeApi>;
      cleanup: () => Promise<void>;
    }> {
      const stub = makeApi();
      managerStub = { api: stub.api, cancelJob: vi.fn() };
      let captured: ReturnType<typeof useAlbumDownload> | null = null;
      const r = await render(<Harness onResult={(res) => { captured = res; }} />);
      return {
        latest: () => captured!,
        stub,
        cleanup: () => r.unmount(),
      };
    }

    it('maps CorruptShardHashError thrown from the coordinator to the corrupt-metadata message', async () => {
      const { CorruptShardHashError } = await import('../coordinator-download-runner');
      const { stub, latest, cleanup } = await arrangeRunningJob();
      stub.startJob.mockImplementationOnce(async () => {
        throw new CorruptShardHashError('ZZZZmalformed-base64url-blob-XXXX');
      });
      await act(async () => {
        await latest().startDownload('alb', 'My Album', photos, { mode: { kind: 'keepOffline' } });
      });
      expect(latest().error).not.toBeNull();
      expect(latest().error!.message).toBe('Download failed: album metadata is corrupt');
      // ZK-safety: the raw malformed value MUST NOT bleed into the UI surface.
      expect(latest().error!.message).not.toContain('ZZZZmalformed');
      await cleanup();
    });

    it('maps CorruptShardManifest to the corrupt-metadata message', async () => {
      const { CorruptShardManifest } = await import('../../lib/shard-integrity');
      const { stub, latest, cleanup } = await arrangeRunningJob();
      stub.startJob.mockImplementationOnce(async () => {
        throw new CorruptShardManifest('ctx', 'hash array length 0 != shard count 1');
      });
      await act(async () => {
        await latest().startDownload('alb', 'My Album', photos, { mode: { kind: 'keepOffline' } });
      });
      expect(latest().error!.message).toBe('Download failed: album metadata is corrupt');
      await cleanup();
    });

    it('maps ShardIntegrityMismatchError to the corrupt-metadata message', async () => {
      const { ShardIntegrityMismatchError } = await import('../../lib/shard-integrity');
      const { stub, latest, cleanup } = await arrangeRunningJob();
      stub.startJob.mockImplementationOnce(async () => {
        throw new ShardIntegrityMismatchError('photo=p1 shard=0');
      });
      await act(async () => {
        await latest().startDownload('alb', 'My Album', photos, { mode: { kind: 'keepOffline' } });
      });
      expect(latest().error!.message).toBe('Download failed: album metadata is corrupt');
      await cleanup();
    });

    it('leaves the generic message in place for unrelated errors', async () => {
      const { stub, latest, cleanup } = await arrangeRunningJob();
      stub.startJob.mockImplementationOnce(async () => {
        throw new Error('boom');
      });
      await act(async () => {
        await latest().startDownload('alb', 'My Album', photos, { mode: { kind: 'keepOffline' } });
      });
      expect(latest().error).not.toBeNull();
      expect(latest().error!.message).not.toBe('Download failed: album metadata is corrupt');
      await cleanup();
    });
  });
});
