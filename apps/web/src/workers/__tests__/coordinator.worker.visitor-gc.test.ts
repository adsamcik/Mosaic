import { describe, expect, it, vi } from 'vitest';
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

registerCoordinatorHooks(cbor);
// ----- Visitor cluster: GC sweep on initialize (Phase 3) -----
describe('visitor GC on startup', () => {
  const visitorScope = 'visitor:99999999999999999999999999999999';
  const ONE_DAY = 24 * 60 * 60 * 1_000;

  it('sweeps a visitor terminal job older than the TTL', async () => {
    const oldJobId = persistSnapshotJob(60, 'Done', photoSpecs(1, 1), {
      scopeKey: visitorScope,
      lastUpdatedAtMs: nowMs - 30 * ONE_DAY,
    });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobs = await worker.listJobs();
    expect(jobs.find((s) => s.jobId === oldJobId)).toBeUndefined();
    expect(opfsState.snapshots.has(oldJobId)).toBe(false);
  });

  it('keeps an auth terminal job at the same age (visitor rule does not apply)', async () => {
    const authJobId = persistSnapshotJob(61, 'Done', photoSpecs(1, 1), {
      scopeKey: 'auth:00000000000000000000000000000000',
      lastUpdatedAtMs: nowMs - 30 * ONE_DAY,
    });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobs = await worker.listJobs();
    expect(jobs.find((s) => s.jobId === authJobId)).toBeDefined();
    expect(opfsState.snapshots.has(authJobId)).toBe(true);
  });

  it('keeps a recent visitor non-terminal job', async () => {
    const fresh = persistSnapshotJob(62, 'Paused', photoSpecs(1, 2), {
      scopeKey: visitorScope,
      lastUpdatedAtMs: nowMs - 1 * ONE_DAY,
    });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    expect(opfsState.snapshots.has(fresh)).toBe(true);
  });
});
