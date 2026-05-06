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
  getOrFetchEpochKey: vi.fn(async () => ({ epochSeed: new Uint8Array(32), epochHandleId: 'h1' })),
}));
vi.mock('../useWakeLock', () => ({
  useWakeLock: () => ({ acquire: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }),
}));
vi.mock('comlink', () => ({ proxy: <T,>(value: T): T => value }));

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
});
