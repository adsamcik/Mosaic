import { describe, expect, it, vi } from 'vitest';
import { WorkerCryptoError, type LinkTierHandleId } from '../types';
import {
  opfsState,
  nowMs,
  photoSpecs,
  persistSnapshotJob,
  makeComlinkMock,
  makeLoggerMock,
  makeOpfsStagingMock,
  rustMocks,
  cryptoPoolMocks,
  pipelineMocks,
  registerCoordinatorHooks,
} from './coordinator.worker.test-shared';

vi.mock('comlink', () => makeComlinkMock());
vi.mock('../../lib/logger', () => makeLoggerMock());
vi.mock('../rust-crypto-core', () => rustMocks);
vi.mock('../crypto-pool', () => cryptoPoolMocks);
vi.mock('../coordinator/photo-pipeline', () => pipelineMocks);
vi.mock('../../lib/opfs-staging', () => makeOpfsStagingMock());

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';
import type { SourceStrategy } from '../coordinator/source-strategy';

registerCoordinatorHooks(cbor);
// ----- Visitor cluster: pause + rebind on reconstruct (Phase 3) -----
describe('visitor reconstruct: pause-no-source + rebind', () => {
  const visitorScope = 'visitor:11111111111111111111111111111111';
  const otherVisitorScope = 'visitor:22222222222222222222222222222222';

  function makeSource(scopeKey: string): SourceStrategy {
    return {
      kind: 'share-link',
      fetchShard: vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
      fetchShards: vi.fn(async (): Promise<Uint8Array[]> => []),
      resolveKey: vi.fn(async () => ({ kind: 'link-tier-handle' as const, handleId: 'lnkt_rebind_test' as LinkTierHandleId })),
      getScopeKey: () => scopeKey,
    };
  }

  it('marks reconstructed visitor jobs as pausedNoSource and surfaces them in resume prompt', async () => {
    const jobId = persistSnapshotJob(50, 'Paused', photoSpecs(1, 2), { scopeKey: visitorScope });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const resumable = await worker.listResumableJobs();
    const item = resumable.find((s) => s.jobId === jobId);
    expect(item).toBeDefined();
    expect(item?.pausedNoSource).toBe(true);
  });

  it('does NOT mark auth or legacy reconstructed jobs as pausedNoSource', async () => {
    const authId = persistSnapshotJob(51, 'Paused', photoSpecs(1, 2), { scopeKey: 'auth:00000000000000000000000000000000' });
    const legacyId = persistSnapshotJob(52, 'Paused', photoSpecs(1, 2));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const resumable = await worker.listResumableJobs();
    const auth = resumable.find((s) => s.jobId === authId);
    const legacy = resumable.find((s) => s.jobId === legacyId);
    expect(auth?.pausedNoSource).toBe(false);
    expect(legacy?.pausedNoSource).toBe(false);
  });

  it('resumeJob rejects DownloadIllegalState until rebind succeeds', async () => {
    const jobId = persistSnapshotJob(53, 'Paused', photoSpecs(1, 2), { scopeKey: visitorScope });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await expect(worker.resumeJob(jobId)).rejects.toBeInstanceOf(WorkerCryptoError);
    await worker.rebindJobSource(jobId, makeSource(visitorScope));
    const resumable = await worker.listResumableJobs();
    expect(resumable.find((s) => s.jobId === jobId)?.pausedNoSource).toBe(false);
  });

  it('rebindJobSource rejects when supplied source scope does not match the job scope', async () => {
    const jobId = persistSnapshotJob(54, 'Paused', photoSpecs(1, 2), { scopeKey: visitorScope });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await expect(
      worker.rebindJobSource(jobId, makeSource(otherVisitorScope)),
    ).rejects.toBeInstanceOf(WorkerCryptoError);
    // Still paused-no-source after a failed rebind.
    const resumable = await worker.listResumableJobs();
    expect(resumable.find((s) => s.jobId === jobId)?.pausedNoSource).toBe(true);
  });

  it('hard-cancel of a paused-no-source visitor job clears the flag and purges OPFS', async () => {
    const jobId = persistSnapshotJob(55, 'Paused', photoSpecs(1, 2), { scopeKey: visitorScope });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.cancelJob(jobId, { soft: false });
    expect(opfsState.snapshots.has(jobId)).toBe(false);
  });
});
