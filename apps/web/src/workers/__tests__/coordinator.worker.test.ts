import { describe, expect, it, vi } from 'vitest';
import { WorkerCryptoErrorCode, type DownloadPhase, type LinkTierHandleId } from '../types';
import {
  rustMocks,
  opfsState,
  pipelineMocks,
  cryptoPoolMocks,
  albumId,
  nowMs,
  validInput,
  snapshotBody,
  parse,
  requiredMapValue,
  expectBytes,
  readPhotoBytesWritten,
  readSnapshotPhase,
  eventKind,
  startPreparingJob,
  hex,
  photoSpecs,
  persistSnapshotJob,
  makeComlinkMock,
  makeLoggerMock,
  makeOpfsStagingMock,
  registerCoordinatorHooks,
} from './coordinator.worker.test-shared';

vi.mock('comlink', () => makeComlinkMock());
vi.mock('../../lib/logger', () => makeLoggerMock());
vi.mock('../rust-crypto-core', () => rustMocks);
vi.mock('../crypto-pool', () => cryptoPoolMocks);
vi.mock('../coordinator/photo-pipeline', () => pipelineMocks);
vi.mock('../../lib/opfs-staging', () => makeOpfsStagingMock());

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';
import * as opfsStaging from '../../lib/opfs-staging';
import type { SourceStrategy } from '../coordinator/source-strategy';

registerCoordinatorHooks(cbor);

describe('CoordinatorWorker', () => {
  it('subscribeToThumbnails emits each thumbnail from the in-memory manifest', async () => {
    vi.useRealTimers();
    // Mock crypto pool so handle decrypt returns the input bytes (identity).
    const decrypt = vi.fn(async (bytes: Uint8Array) => bytes);
    cbor.setCryptoPoolFactory(async () => ({
      size: 1,
      decryptShardWithTierKey: vi.fn(),
      decryptShardWithEpochHandle: vi.fn(),
      decryptShardWithLinkTierHandle: vi.fn(async (_handle: LinkTierHandleId, bytes: Uint8Array) => decrypt(bytes)),
    } as unknown as Awaited<ReturnType<typeof cryptoPoolMocks.getCryptoPool>>));
    const fetched: string[] = [];
    const fakeSource: SourceStrategy = {
      kind: 'authenticated',
      getScopeKey: (): string => 'auth:00000000000000000000000000000000',
      fetchShard: async (id: string): Promise<Uint8Array> => { fetched.push(id); return new Uint8Array([id.charCodeAt(0)]); },
      fetchShards: async (): Promise<Uint8Array[]> => [],
      resolveKey: async () => ({ kind: 'link-tier-handle' as const, handleId: 'lnkt_thumb_test' as LinkTierHandleId }),
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({
      ...validInput(),
      source: fakeSource,
      thumbnails: [
        { photoId: 'p-A', epochId: '7', thumbShardId: 'shard-aaaa' },
        { photoId: 'p-B', epochId: '7', thumbShardId: 'shard-bbbb' },
      ],
    });
    // Provide URL.createObjectURL stub for the test environment.
    const created: string[] = [];
    const revoked: string[] = [];
    let n = 0;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (_b: Blob): string => { n += 1; const u = 'blob:int#' + n; created.push(u); return u; };
    URL.revokeObjectURL = (u: string): void => { revoked.push(u); };
    try {
      const received: Array<{ photoId: string; blobUrl: string }> = [];
      const sub = await worker.subscribeToThumbnails(jobId, (photoId, blobUrl): void => {
        received.push({ photoId, blobUrl });
      });
      await vi.waitFor(() => {
        expect(received.length).toBe(2);
      });
      expect(received.map((r) => r.photoId).sort()).toEqual(['p-A', 'p-B']);
      expect(fetched.sort()).toEqual(['shard-aaaa', 'shard-bbbb']);
      sub.unsubscribe();
      // Allow stop's microtask to revoke.
      await new Promise((r) => setTimeout(r, 10));
      expect(revoked.length).toBe(created.length);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('initializes empty state', async () => {
    const worker = new CoordinatorWorker();
    await expect(worker.initialize({ nowMs })).resolves.toEqual({ reconstructedJobs: 0 });
    await expect(worker.listJobs()).resolves.toEqual([]);
  });

  it('starts a job and transitions into Running after PlanReady', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob(validInput());
    expect(jobId).toMatch(/^[0-9a-f]{32}$/u);
    const jobs = await worker.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.phase).toBe('Running');
    const job = jobs[0];
    if (!job) throw new Error('expected job');
    expect(job.photoCounts.pending + job.photoCounts.inflight + job.photoCounts.done).toBe(1);
  });

  it('rejects invalid tier-2 plans with DownloadInvalidPlan', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await expect(worker.startJob(validInput(2))).rejects.toMatchObject({
      code: WorkerCryptoErrorCode.DownloadInvalidPlan,
    });
  });

  it('sends pause and resume events after PlanReady', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await expect(worker.sendEvent(jobId, { kind: 'PlanReady' })).resolves.toEqual({ phase: 'Running' });
    await expect(worker.pauseJob(jobId)).resolves.toEqual({ phase: 'Paused' });
    await expect(worker.resumeJob(jobId)).resolves.toEqual({ phase: 'Running' });
  });

  it('cancel-soft preserves OPFS and is reconstructable', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await worker.cancelJob(jobId, { soft: true });
    await expect(opfsStaging.jobExists(jobId)).resolves.toBe(true);
    expect(await worker.getJob(jobId)).not.toBeNull();

    const nextWorker = new CoordinatorWorker();
    await expect(nextWorker.initialize({ nowMs })).resolves.toEqual({ reconstructedJobs: 1 });
    expect((await nextWorker.listJobs())[0]?.phase).toBe('Cancelled');
  });


  it('driver completes a photo and finalizes the job', async () => {
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 123 });
  cbor.setCryptoPoolFactory(cryptoPoolMocks.getCryptoPool);
  cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await vi.waitFor(async () => {
      expect((await worker.getJob(jobId))?.phase).toBe('Done');
    });
    expect((await worker.getJob(jobId))?.photoCounts.done).toBe(1);
  });

  it('driver keeps cancelled in-flight photos pending on pause and resumes them', async () => {
    pipelineMocks.executePhotoTask.mockImplementation(async (input: { readonly signal: AbortSignal }) => {
      if (!input.signal.aborted) {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { kind: 'failed', code: 'Cancelled' };
    });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.photoCounts.inflight).toBe(1));
    await worker.pauseJob(jobId);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.phase).toBe('Paused'));
    expect((await worker.getJob(jobId))?.photoCounts.pending).toBe(1);

    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 123 });
  cbor.setCryptoPoolFactory(cryptoPoolMocks.getCryptoPool);
  cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);
    await worker.resumeJob(jobId);
    await cbor.runJobDriver(worker, jobId);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.phase).toBe('Done'));
  });



  it('reuses one crypto pool across sequential job drivers', async () => {
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 123 });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const firstJob = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(firstJob))?.phase).toBe('Done'));

    const secondJob = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(secondJob))?.phase).toBe('Done'));

    expect(cryptoPoolMocks.getCryptoPool).toHaveBeenCalledTimes(1);
  });

  it('shuts down the cached crypto pool on coordinator clear', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.phase).toBe('Done'));

    await worker.clear();

    expect(cryptoPoolMocks.pool.shutdown).toHaveBeenCalledTimes(1);
  });

  it('driver records one-photo integrity failure and still finalizes', async () => {
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'failed', code: 'Integrity' });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.phase).toBe('Done'));
    const job = await worker.getJob(jobId);
    expect(job?.photoCounts.failed).toBe(1);
    expect(job?.failureCount).toBe(1);
  });

  it('driver stops the whole job on access revocation', async () => {
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'failed', code: 'AccessRevoked' });
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await cbor.runJobDriver(worker, jobId);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.phase).toBe('Errored'));
  });
  it('cancel-hard purges OPFS and removes the job', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await worker.cancelJob(jobId, { soft: false });
    await expect(opfsStaging.jobExists(jobId)).resolves.toBe(false);
    await expect(worker.listJobs()).resolves.toEqual([]);
  });

  it('reconstructs persisted jobs on a second worker', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await worker.sendEvent(jobId, { kind: 'PlanReady' });

    const nextWorker = new CoordinatorWorker();
    await nextWorker.initialize({ nowMs });
    const jobs = await nextWorker.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.phase).toBe('Running');
  });

  it('refreshes a cached job from OPFS when another coordinator broadcasts changes', async () => {
    const workerA = new CoordinatorWorker();
    const workerB = new CoordinatorWorker();
    await workerA.initialize({ nowMs });
    await workerB.initialize({ nowMs });

    const jobId = await startPreparingJob(workerA);
    await Promise.resolve();
    expect((await workerB.getJob(jobId))?.phase).toBe('Running');

    const phases: DownloadPhase[] = [];
    await workerB.subscribe(jobId, (event) => {
      phases.push(event.phase);
    });

    await workerA.sendEvent(jobId, { kind: 'PlanReady' });
    await Promise.resolve();
    await workerA.pauseJob(jobId);
    await vi.waitFor(() => {
      expect(phases).toContain('Paused');
    });

    expect(phases[0]).toBe('Running');
    expect(phases).toContain('Paused');
    expect((await workerB.getJob(jobId))?.phase).toBe('Paused');
  });

  it('serializes concurrent pause requests for one job and keeps OPFS plus memory paused', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await worker.sendEvent(jobId, { kind: 'PlanReady' });

    await expect(Promise.all(Array.from({ length: 5 }, () => worker.pauseJob(jobId))))
      .resolves.toEqual(Array.from({ length: 5 }, () => ({ phase: 'Paused' })));

    expect((await worker.getJob(jobId))?.phase).toBe('Paused');
    expect(readSnapshotPhase(opfsState.snapshots.get(jobId)?.body ?? new Uint8Array())).toBe('Paused');
    const pauseTransitions = rustMocks.rustApplyDownloadEvent.mock.calls.filter(([, eventBytes]) => eventKind(eventBytes) === 2);
    expect(pauseTransitions).toHaveLength(1);
  });

  it('subscribes and unsubscribes from progress events', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    const events: DownloadPhase[] = [];
    const subscription = await worker.subscribe(jobId, (event) => {
      events.push(event.phase);
    });
    await worker.sendEvent(jobId, { kind: 'PlanReady' });
    subscription.unsubscribe();
    await worker.pauseJob(jobId);
    expect(events.slice(0, 2)).toEqual(['Running', 'Running']);
    expect(events).not.toContain('Paused');
  });

  it('garbage-collects stale jobs', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    const existing = opfsState.snapshots.get(jobId);
    if (!existing) throw new Error('expected snapshot');
    opfsState.snapshots.set(jobId, {
      body: snapshotBody({
        jobIdBytes: expectBytes(requiredMapValue(parse(existing.body), 1)),
        phase: 'Preparing',
        createdAtMs: nowMs - 10 * 24 * 60 * 60 * 1000,
        lastUpdatedAtMs: nowMs - 10 * 24 * 60 * 60 * 1000,
        photoCount: 1,
      }),
      checksum: existing.checksum,
    });
    await expect(worker.gc({ nowMs, maxAgeMs: 7 * 24 * 60 * 60 * 1000 })).resolves.toEqual({ purged: [jobId] });
    await expect(opfsStaging.jobExists(jobId)).resolves.toBe(false);
  });


  it('rate-limits byte-progress snapshot persistence', async () => {
    let report: (jobId: string, photoId: string, bytesWritten: number) => void = () => { throw new Error('expected byte-progress reporter'); };
    pipelineMocks.executePhotoTask.mockImplementation(async (input, deps) => {
      report = deps?.reportBytesWritten ?? report;
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { kind: 'failed', code: 'Cancelled' };
    });
    const worker = new CoordinatorWorker({ byteProgressRateLimitMs: 50 });
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.photoCounts.inflight).toBe(1));
    const baselineWrites = vi.mocked(opfsStaging.writeSnapshot).mock.calls.length;

    for (let index = 1; index <= 10; index += 1) {
      vi.setSystemTime(nowMs + index * 5);
      report(jobId, '018f0000-0000-7000-8000-000000000101', index * 10);
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(60);

    const byteProgressWrites = vi.mocked(opfsStaging.writeSnapshot).mock.calls.length - baselineWrites;
    expect(byteProgressWrites).toBeLessThanOrEqual(3);
    const persisted = opfsState.snapshots.get(jobId);
    if (!persisted) throw new Error('expected snapshot');
    expect(readPhotoBytesWritten(persisted.body, '018f0000-0000-7000-8000-000000000101')).toBe(100);
    await worker.cancelJob(jobId, { soft: true });
  });

  it('pause flushes pending byte progress immediately', async () => {
    let report: (jobId: string, photoId: string, bytesWritten: number) => void = () => { throw new Error('expected byte-progress reporter'); };
    pipelineMocks.executePhotoTask.mockImplementation(async (input, deps) => {
      report = deps?.reportBytesWritten ?? report;
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { kind: 'failed', code: 'Cancelled' };
    });
    const worker = new CoordinatorWorker({ byteProgressRateLimitMs: 50 });
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await vi.waitFor(async () => expect((await worker.getJob(jobId))?.photoCounts.inflight).toBe(1));

    report(jobId, '018f0000-0000-7000-8000-000000000101', 77);
    await worker.pauseJob(jobId);

    const persisted = opfsState.snapshots.get(jobId);
    if (!persisted) throw new Error('expected snapshot');
    expect(readPhotoBytesWritten(persisted.body, '018f0000-0000-7000-8000-000000000101')).toBe(77);
  });

  it('lists only useful non-terminal resumable jobs', async () => {
    const jobA = persistSnapshotJob(1, 'Running', photoSpecs(5, 10));
    persistSnapshotJob(2, 'Done', photoSpecs(5, 10));
    persistSnapshotJob(3, 'Errored', photoSpecs(0, 10));
    const jobD = persistSnapshotJob(4, 'Paused', photoSpecs(3, 10));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });

    const resumable = await worker.listResumableJobs();

    expect(resumable.map((job) => job.jobId).sort()).toEqual([jobA, jobD].sort());
    expect(resumable.find((job) => job.jobId === jobA)).toMatchObject({ photosDone: 5, photosTotal: 10 });
    expect(resumable.find((job) => job.jobId === jobD)).toMatchObject({ photosDone: 3, photosTotal: 10 });
  });

  it('computes added removed rekeyed and unchanged album diff buckets', async () => {
    const shardA = new Uint8Array(16).fill(10);
    const shardB = new Uint8Array(16).fill(11);
    const shardC = new Uint8Array(16).fill(12);
    const jobId = persistSnapshotJob(5, 'Paused', [
      { photoId: 'a', epochId: 1, shardIds: [shardA] },
      { photoId: 'b', epochId: 1, shardIds: [shardB] },
      { photoId: 'c', epochId: 1, shardIds: [shardC] },
    ]);
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });

    await expect(worker.computeAlbumDiff(jobId, {
      albumId,
      photos: [
        { photoId: 'a', epochId: 1, tier3ShardIds: [hex(shardA)] },
        { photoId: 'b', epochId: 2, tier3ShardIds: [hex(shardB)] },
        { photoId: 'd', epochId: 1, tier3ShardIds: [hex(new Uint8Array(16).fill(13))] },
      ],
    })).resolves.toEqual({
      removed: ['c'],
      added: ['d'],
      rekeyed: ['b'],
      unchanged: ['a'],
      shardChanged: [],
    });
  });

  it('startJob accepts an outputMode and dispatches the matching finalizer', async () => {
    const zipFinalizer = vi.fn(async () => undefined);
    cbor.setRunZipFinalizer(zipFinalizer as unknown as Parameters<typeof cbor.setRunZipFinalizer>[0]);
    const openZipSaveTarget = vi.fn(async () => ({
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }));
    const provider = {
      openZipSaveTarget,
      openPerFileSaveTarget: vi.fn(async () => ({
        openOne: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) })),
        finalize: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    const { jobId } = await worker.startJob({ ...validInput(), outputMode: { kind: 'zip', fileName: 'album.zip' } });
    await cbor.awaitScheduledDriver(worker, jobId);
    expect((await worker.getJob(jobId))?.phase).toBe('Done');
    expect(zipFinalizer).toHaveBeenCalledTimes(1);
    const calls = zipFinalizer.mock.calls as unknown as ReadonlyArray<readonly [unknown, string, ...unknown[]]>;
    if (calls.length === 0) throw new Error('expected call');
    expect(calls[0]?.[1]).toBe('album.zip');
  });


  it.each(['webShare', 'fsAccessPerFile', 'fsAccessDirectory', 'blobAnchor'] as const)('dispatches perFile finalizer for %s strategy', async (strategy) => {
    const perFileFinalizer = vi.fn(async () => undefined);
    cbor.setRunPerFileFinalizer(perFileFinalizer as unknown as Parameters<typeof cbor.setRunPerFileFinalizer>[0]);
    const provider = {
      openZipSaveTarget: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) })),
      openPerFileSaveTarget: vi.fn(async () => ({
        openOne: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) })),
        finalize: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    const { jobId } = await worker.startJob({ ...validInput(), outputMode: { kind: 'perFile', strategy } });
    await cbor.awaitScheduledDriver(worker, jobId);
    expect((await worker.getJob(jobId))?.phase).toBe('Done');
    expect(perFileFinalizer).toHaveBeenCalledTimes(1);
    const calls = perFileFinalizer.mock.calls as unknown as ReadonlyArray<readonly [unknown, typeof strategy, ...unknown[]]>;
    expect(calls[0]?.[1]).toBe(strategy);
  });

  it('keepOffline (default) finalizer is a no-op and does not call save-target provider', async () => {
    const zipFinalizer = vi.fn(async () => undefined);
    cbor.setRunZipFinalizer(zipFinalizer as unknown as Parameters<typeof cbor.setRunZipFinalizer>[0]);
    const provider = {
      openZipSaveTarget: vi.fn(),
      openPerFileSaveTarget: vi.fn(),
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    const { jobId } = await worker.startJob({ ...validInput(), outputMode: { kind: 'keepOffline' } });
    await cbor.awaitScheduledDriver(worker, jobId);
    expect((await worker.getJob(jobId))?.phase).toBe('Done');
    expect(zipFinalizer).not.toHaveBeenCalled();
    expect(provider.openZipSaveTarget).not.toHaveBeenCalled();
    expect(provider.openPerFileSaveTarget).not.toHaveBeenCalled();
  });

  it('zip finalizer failure transitions the job to Errored', async () => {
    cbor.setRunZipFinalizer(((async (): Promise<void> => { throw new Error('boom'); }) as unknown) as Parameters<typeof cbor.setRunZipFinalizer>[0]);
    const provider = {
      openZipSaveTarget: vi.fn(async () => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
      openPerFileSaveTarget: vi.fn(async () => ({
        openOne: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) })),
        finalize: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    const { jobId } = await worker.startJob({ ...validInput(), outputMode: { kind: 'zip', fileName: 'a.zip' } });
    await cbor.awaitScheduledDriver(worker, jobId);
    expect((await worker.getJob(jobId))?.phase).toBe('Errored');
  });

  // ----- C2/C3: reconstructed-resume + Finalizing-recovery -----
  it('does NOT auto-spin drivers for reconstructed Running or Paused jobs and surfaces them via listResumableJobs', async () => {
    const runningJob = persistSnapshotJob(11, 'Running', photoSpecs(2, 5));
    const pausedJob = persistSnapshotJob(12, 'Paused', photoSpecs(3, 5));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    // No driver was scheduled: any executePhotoTask invocation would prove
    // we silently auto-resumed.
    expect(pipelineMocks.executePhotoTask).not.toHaveBeenCalled();
    const resumable = await worker.listResumableJobs();
    expect(resumable.map((job) => job.jobId).sort()).toEqual([runningJob, pausedJob].sort());
  });

  it('resumeJob({ mode }) registers the user-chosen mode for reconstructed Running jobs and dispatches the matching finalizer', async () => {
    const zipFinalizer = vi.fn(async () => undefined);
    cbor.setRunZipFinalizer(zipFinalizer as unknown as Parameters<typeof cbor.setRunZipFinalizer>[0]);
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 123 });
    const provider = {
      openZipSaveTarget: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) })),
      openPerFileSaveTarget: vi.fn(),
    };
    const jobId = persistSnapshotJob(21, 'Running', photoSpecs(0, 1));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    // Without explicit resumeJob({mode}) the job stays idle.
    expect(pipelineMocks.executePhotoTask).not.toHaveBeenCalled();

    await worker.resumeJob(jobId, { mode: { kind: 'zip', fileName: 'restored.zip' } });
    await cbor.awaitScheduledDriver(worker, jobId);

    expect((await worker.getJob(jobId))?.phase).toBe('Done');
    expect(zipFinalizer).toHaveBeenCalledTimes(1);
    const calls = zipFinalizer.mock.calls as unknown as ReadonlyArray<readonly [unknown, string, ...unknown[]]>;
    expect(calls[0]?.[1]).toBe('restored.zip');
  });

  it('listResumableJobs includes Finalizing jobs (worker-crash recovery)', async () => {
    const jobId = persistSnapshotJob(31, 'Finalizing', photoSpecs(5, 5));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const resumable = await worker.listResumableJobs();
    expect(resumable.map((job) => job.jobId)).toEqual([jobId]);
  });

  it('resumeJob({ mode }) on a Finalizing job re-runs the finalizer and emits FinalizationDone', async () => {
    const perFileFinalizer = vi.fn(async () => undefined);
    cbor.setRunPerFileFinalizer(perFileFinalizer as unknown as Parameters<typeof cbor.setRunPerFileFinalizer>[0]);
    const provider = {
      openZipSaveTarget: vi.fn(),
      openPerFileSaveTarget: vi.fn(async () => ({
        openOne: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) })),
        finalize: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
    };
    const jobId = persistSnapshotJob(41, 'Finalizing', photoSpecs(3, 3));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);

    await worker.resumeJob(jobId, { mode: { kind: 'perFile', strategy: 'fsAccessPerFile' } });
    await cbor.awaitScheduledDriver(worker, jobId);

    expect(perFileFinalizer).toHaveBeenCalledTimes(1);
    expect((await worker.getJob(jobId))?.phase).toBe('Done');
  });

  // ----- S5: per-file export failure does not clobber done photo state -----
  it('recordPhotoFailure preserves done source state and does NOT mark the photo Cancelled', async () => {
    // Drive a startJob through to Finalizing-equivalent and then exercise the
    // per-file finalizer dependency directly.
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 50 });
    let capturedDeps: { readonly recordPhotoFailure?: (jobId: string, photoId: string, reason: string) => Promise<void> } | null = null;
    cbor.setRunPerFileFinalizer((async (_job: unknown, _strategy: unknown, deps: unknown): Promise<void> => {
      capturedDeps = deps as typeof capturedDeps;
    }) as unknown as Parameters<typeof cbor.setRunPerFileFinalizer>[0]);
    const provider = {
      openZipSaveTarget: vi.fn(),
      openPerFileSaveTarget: vi.fn(async () => ({
        openOne: vi.fn(),
        finalize: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    const { jobId } = await worker.startJob({ ...validInput(), outputMode: { kind: 'perFile', strategy: 'fsAccessPerFile' } });
    await cbor.awaitScheduledDriver(worker, jobId);

    expect(capturedDeps).not.toBeNull();
    const deps = capturedDeps as unknown as { readonly recordPhotoFailure: (jobId: string, photoId: string, reason: string) => Promise<void> };
    const before = await worker.getJob(jobId);
    expect(before?.photoCounts.done).toBe(1);

    // Simulate an export-side failure for an already-staged photo.
    await deps.recordPhotoFailure(jobId, '018f0000-0000-7000-8000-000000000101', 'IllegalState');

    const after = await worker.getJob(jobId);
    // Source-state photo MUST remain done — staged bytes are still good.
    expect(after?.photoCounts.done).toBe(1);
    expect(after?.photoCounts.failed).toBe(0);
  });

    it('computes shardChanged when epoch is unchanged but tier-3 shards differ', async () => {
    const jobId = persistSnapshotJob(6, 'Paused', [
      { photoId: 'a', epochId: 1, shardIds: [new Uint8Array(16).fill(14)] },
    ]);
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });

    await expect(worker.computeAlbumDiff(jobId, {
      albumId,
      photos: [{ photoId: 'a', epochId: 1, tier3ShardIds: [hex(new Uint8Array(16).fill(15))] }],
    })).resolves.toEqual({
      removed: [],
      added: [],
      rekeyed: [],
      unchanged: [],
      shardChanged: ['a'],
    });
  });

  // ----- SourceStrategy integration -----
  it('routes pipeline shard + key requests through the provided source strategy', async () => {
    interface FullDeps {
      readonly fetchShards: (ids: ReadonlyArray<string>, signal: AbortSignal) => Promise<Uint8Array[]>;
      readonly getEpochSeed: (albumId: string, epochId: number) => Promise<{ kind: 'link-tier-handle'; handleId: LinkTierHandleId }>;
    }
    const fetchSpy = vi.fn(async (_ids: ReadonlyArray<string>, _signal: AbortSignal): Promise<Uint8Array[]> => [new Uint8Array([1, 2, 3])]);
    const resolveSpy = vi.fn(async (_albumId: string, _epochId: number) => ({
      kind: 'link-tier-handle' as const,
      handleId: 'lnkt_source_test' as LinkTierHandleId,
    }));
    const customSource: SourceStrategy = {
      kind: 'share-link',
      fetchShard: vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
      fetchShards: fetchSpy,
      resolveKey: resolveSpy,
      getScopeKey: () => 'visitor:00000000000000000000000000000000',
    };
    pipelineMocks.executePhotoTask.mockImplementation(async (_input, deps) => {
      const full = deps as unknown as FullDeps;
      const shards = await full.fetchShards(['shard-x'], new AbortController().signal);
      const key = await full.getEpochSeed(albumId, 7);
      expect(shards).toHaveLength(1);
      expect(key.kind).toBe('link-tier-handle');
      expect(key.handleId).toBe('lnkt_source_test');
      return { kind: 'done', bytesWritten: 123 };
    });
    cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);

    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({ ...validInput(), source: customSource });
    await cbor.awaitScheduledDriver(worker, jobId);

    expect(cbor.getJobSource(worker, jobId)).toBe(customSource);
    // After v3-10 fix: signal is consumed worker-side via raceWithAbort and
    // never crosses the SourceStrategy boundary (AbortSignal is not
    // structured-cloneable across Comlink proxies for visitor flows).
    expect(fetchSpy).toHaveBeenCalledWith(['shard-x'], undefined);
    expect(resolveSpy).toHaveBeenCalledWith(albumId, 7);
    expect((await worker.getJob(jobId))?.phase).toBe('Done');
  });

  it('defaults to the authenticated source when StartJobInput.source is omitted', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob(validInput());
    await cbor.awaitScheduledDriver(worker, jobId);
    // No per-job source registered: pipelineDeps will resolve via the lazy
    // default authenticated source on each driver tick.
    expect(cbor.getJobSource(worker, jobId)).toBeNull();
    expect((await worker.getJob(jobId))?.phase).toBe('Done');
    expect(pipelineMocks.executePhotoTask).toHaveBeenCalled();
  });

  it('reconstructed jobs have no per-job source and fall back to authenticated on resume', async () => {
    const reconstructedJobId = persistSnapshotJob(42, 'Running', photoSpecs(0, 1));
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    // No per-job source survives a worker restart.
    expect(cbor.getJobSource(worker, reconstructedJobId)).toBeNull();
    // Resume re-spins the driver using the default authenticated source.
    pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 50 });
    cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);
    await worker.resumeJob(reconstructedJobId);
    await cbor.awaitScheduledDriver(worker, reconstructedJobId);
    expect(cbor.getJobSource(worker, reconstructedJobId)).toBeNull();
    expect(pipelineMocks.executePhotoTask).toHaveBeenCalled();
  });

  // ----- Scope key persistence (Phase 3 visitor tray) -----
  it('persists scope_key from input source onto the snapshot and JobSummary', async () => {
    const visitorScope = 'visitor:11111111111111111111111111111111';
    const visitorSource: SourceStrategy = {
      kind: 'share-link',
      fetchShard: vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
      fetchShards: vi.fn(async (): Promise<Uint8Array[]> => []),
      resolveKey: vi.fn(async () => ({ kind: 'link-tier-handle' as const, handleId: 'lnkt_scope_test' as LinkTierHandleId })),
      getScopeKey: () => visitorScope,
    };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({ ...validInput(), source: visitorSource });
    const summaries = await worker.listJobs();
    const summary = summaries.find((s) => s.jobId === jobId);
    expect(summary?.scopeKey).toBe(visitorScope);
    // Verify the scope_key was passed through to the WASM init call.
    expect(rustMocks.rustInitDownloadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: visitorScope }),
    );
  });

  it('falls back to the configured accountId scope when source is omitted', async () => {
    const worker = new CoordinatorWorker({ accountId: 'acct-xyz' });
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob(validInput());
    const summary = (await worker.getJob(jobId)) ?? null;
    expect(summary?.scopeKey).toMatch(/^auth:[0-9a-f]{32}$/u);
  });

});
