import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, flushMicrotasks } from '../../components/Download/__tests__/DownloadTestUtils';
import type { CoordinatorWorkerApi, JobProgressEvent, PhotoMeta } from '../../workers/types';
import type { LinkDecryptionKey } from '../../workers/types';

// --- mocks ---------------------------------------------------------------

vi.mock('../../lib/album-download-service', () => ({
  downloadAlbumAsZip: vi.fn(),
  supportsFileSystemAccess: () => true,
}));
vi.mock('../../lib/save-target-bridge', () => ({ defaultSaveTargetProvider: vi.fn() }));
vi.mock('../../lib/epoch-key-service', () => ({
  getOrFetchEpochKey: vi.fn(async () => { throw new Error('visitor has no epoch service'); }),
}));
vi.mock('../useWakeLock', () => ({
  useWakeLock: () => ({ acquire: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }),
}));
vi.mock('comlink', () => ({ proxy: <T,>(value: T): T => value }));

const shareLinkSrc = vi.hoisted(() => ({
  downloadShardViaShareLink: vi.fn(async () => new Uint8Array()),
}));
vi.mock('../../lib/shard-service', () => ({
  downloadShardViaShareLink: shareLinkSrc.downloadShardViaShareLink,
  downloadShard: vi.fn(),
  downloadShards: vi.fn(),
  ShardDownloadError: class extends Error {},
}));

interface ManagerStub {
  api: CoordinatorWorkerApi | null;
  cancelJob: ReturnType<typeof vi.fn>;
  resumableJobs: ReadonlyArray<unknown>;
}
let managerStub: ManagerStub;
vi.mock('../useDownloadManager', () => ({
  useDownloadManager: (): unknown => managerStub,
}));

import { useVisitorAlbumDownload } from '../useVisitorAlbumDownload';

// --- fixtures ------------------------------------------------------------

const photos: PhotoMeta[] = [{
  id: 'p1', assetId: 'a1', albumId: 'alb', filename: 'one.jpg',
  mimeType: 'image/jpeg', width: 1, height: 1, tags: [],
  createdAt: '2025-01-01', updatedAt: '2025-01-01',
  shardIds: [], originalShardIds: ['ab'.repeat(16)], epochId: 7,
}];

interface ApiStub {
  api: CoordinatorWorkerApi;
  subscribers: Map<string, (e: JobProgressEvent) => void>;
  startJob: ReturnType<typeof vi.fn>;
}

function makeApi(): ApiStub {
  const subscribers = new Map<string, (e: JobProgressEvent) => void>();
  const startJob = vi.fn(async () => ({ jobId: 'job-v1' }));
  const api: Partial<CoordinatorWorkerApi> = {
    startJob: startJob as unknown as CoordinatorWorkerApi['startJob'],
    subscribe: vi.fn(async (jobId: string, cb: (e: JobProgressEvent) => void) => {
      subscribers.set(jobId, cb);
      return { unsubscribe: () => subscribers.delete(jobId) };
    }) as unknown as CoordinatorWorkerApi['subscribe'],
    cancelJob: vi.fn(async () => ({ phase: 'Cancelled' as const })),
  };
  return { api: api as CoordinatorWorkerApi, subscribers, startJob };
}

interface HarnessProps {
  readonly linkId: string;
  readonly grantToken?: string | null;
  readonly getTier3Key: (epochId: number) => LinkDecryptionKey | undefined;
  readonly onResult: (r: ReturnType<typeof useVisitorAlbumDownload>) => void;
}
function Harness(p: HarnessProps): null {
  const r = useVisitorAlbumDownload({
    linkId: p.linkId,
    grantToken: p.grantToken ?? null,
    getTier3Key: p.getTier3Key,
  });
  p.onResult(r);
  return null;
}

beforeEach(() => {
  managerStub = { api: null, cancelJob: vi.fn(), resumableJobs: [] };
});
afterEach(() => { document.body.replaceChildren(); });

describe('useVisitorAlbumDownload', () => {
  it('starts a coordinator job with a share-link source strategy', async () => {
    const stub = makeApi();
    managerStub = { api: stub.api, cancelJob: vi.fn(), resumableJobs: [] };
    const tier3: LinkDecryptionKey = new Uint8Array(32).fill(5);
    let latest: ReturnType<typeof useVisitorAlbumDownload> | null = null;

    const r = await render(
      <Harness
        linkId="L1"
        grantToken="g-tok"
        getTier3Key={(epoch) => (epoch === 7 ? tier3 : undefined)}
        onResult={(x) => { latest = x; }}
      />,
    );

    let startPromise: Promise<void>;
    await act(async () => {
      startPromise = latest!.startDownload('alb', 'My Shared Album', photos, { kind: 'zip', fileName: 'a.zip' });
    });

    expect(stub.startJob).toHaveBeenCalledTimes(1);
    const args = stub.startJob.mock.calls[0]?.[0] as {
      albumId: string;
      outputMode: { kind: string; fileName?: string };
      source?: { kind: string; resolveKey: (a: string, e: number) => Promise<Uint8Array> };
    };
    expect(args.albumId).toBe('alb');
    expect(args.outputMode).toEqual({ kind: 'zip', fileName: 'a.zip' });
    expect(args.source).toBeDefined();
    expect(args.source!.kind).toBe('share-link');
    // The strategy resolves the tier-3 key for the photo's epoch.
    const resolved = await args.source!.resolveKey('alb', 7);
    expect(resolved).toBe(tier3);

    await act(async () => {
      const cb = stub.subscribers.get('job-v1');
      cb?.({ jobId: 'job-v1', phase: 'Done', photoCounts: { pending: 0, inflight: 0, done: 1, failed: 0, skipped: 0 }, failureCount: 0, lastUpdatedAtMs: 0 });
      await startPromise!;
    });

    expect(latest!.error).toBeNull();
    await r.unmount();
  });

  it('does nothing and surfaces an error when the coordinator manager is not ready', async () => {
    managerStub = { api: null, cancelJob: vi.fn(), resumableJobs: [] };
    let latest: ReturnType<typeof useVisitorAlbumDownload> | null = null;
    const r = await render(
      <Harness
        linkId="L1"
        getTier3Key={() => undefined}
        onResult={(x) => { latest = x; }}
      />,
    );
    await act(async () => {
      await latest!.startDownload('alb', 'n', photos, { kind: 'zip', fileName: 'a.zip' });
    });
    expect(latest!.error).toBeInstanceOf(Error);
    expect(latest!.error!.message).toMatch(/coordinator/i);
    await r.unmount();
  });

  it('cancel() aborts and hard-cancels the coordinator job', async () => {
    const stub = makeApi();
    const cancelJob = vi.fn(async () => ({ phase: 'Cancelled' }));
    managerStub = { api: stub.api, cancelJob, resumableJobs: [] };
    let latest: ReturnType<typeof useVisitorAlbumDownload> | null = null;
    const r = await render(
      <Harness
        linkId="L1"
        getTier3Key={() => new Uint8Array(32)}
        onResult={(x) => { latest = x; }}
      />,
    );
    let startPromise: Promise<void>;
    await act(async () => {
      startPromise = latest!.startDownload('alb', 'n', photos, { kind: 'zip', fileName: 'a.zip' });
    });
    await act(async () => {
      latest!.cancel();
      await startPromise!.catch(() => undefined);
    });
    expect(cancelJob).toHaveBeenCalledWith('job-v1', { soft: false });
    await r.unmount();
  });

  it('rebinds reconstructed visitor jobs whose scope key matches and skips others', async () => {
    const stub = makeApi();
    const rebind = vi.fn(async (): Promise<void> => undefined);
    (stub.api as unknown as { rebindJobSource: typeof rebind }).rebindJobSource = rebind;
    // Two paused-no-source jobs: one matches the link's scope (rebinds), one does not.
    await import('../../lib/scope-key').then((mod) => mod.ensureScopeKeySodiumReady());
    const { deriveVisitorScopeKey } = await import('../../lib/scope-key');
    const matchScope = deriveVisitorScopeKey('link-a', null);
    const otherScope = deriveVisitorScopeKey('link-b', null);
    managerStub = {
      api: stub.api,
      cancelJob: vi.fn(),
      resumableJobs: [
        { jobId: 'match', scopeKey: matchScope, pausedNoSource: true },
        { jobId: 'other', scopeKey: otherScope, pausedNoSource: true },
        { jobId: 'live', scopeKey: matchScope, pausedNoSource: false },
      ],
    };
    const tier3: LinkDecryptionKey = new Uint8Array(32).fill(5);
    const r = await render(
      <Harness
        linkId={'link-a'}
        grantToken={null}
        getTier3Key={() => tier3}
        onResult={() => undefined}
      />,
    );
    // Allow effect microtasks to drain.
    await act(async () => { await flushMicrotasks(); await flushMicrotasks(); });
    expect(rebind).toHaveBeenCalledTimes(1);
    const firstCall = rebind.mock.calls[0] as [string, unknown] | undefined;
    expect(firstCall?.[0]).toBe('match');
    await r.unmount();
  });

});
