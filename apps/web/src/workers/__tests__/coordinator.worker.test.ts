import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCryptoError, WorkerCryptoErrorCode, type DownloadPhase, type StartJobInput } from '../types';

const rustMocks = vi.hoisted(() => ({
  ensureRustReady: vi.fn<() => Promise<void>>(),
  rustApplyDownloadEvent: vi.fn<(stateBytes: Uint8Array, eventBytes: Uint8Array) => Promise<{ newStateBytes: Uint8Array }>>(),
  rustBuildDownloadPlan: vi.fn<(input: { readonly photos: readonly { readonly shards: readonly { readonly tier: number }[] }[] }) => Promise<{ planBytes: Uint8Array }>>(),
  rustCommitDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array) => Promise<{ checksum: Uint8Array }>>(),
  rustInitDownloadSnapshot: vi.fn<(input: { readonly jobId: Uint8Array; readonly albumId: string; readonly planBytes: Uint8Array; readonly nowMs: number }) => Promise<{ bodyBytes: Uint8Array; checksum: Uint8Array }>>(),
  rustLoadDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array, checksum: Uint8Array) => Promise<{ snapshotBytes: Uint8Array; schemaVersionLoaded: number }>>(),
  rustVerifyDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array, checksum: Uint8Array) => Promise<{ valid: boolean }>>(),
}));

const opfsState = vi.hoisted(() => ({
  dirs: new Set<string>(),
  snapshots: new Map<string, { body: Uint8Array; checksum: Uint8Array }>(),
  tempSnapshots: new Map<string, Uint8Array>(),
}));

const pipelineMocks = vi.hoisted(() => ({
  executePhotoTask: vi.fn<(input: { readonly signal: AbortSignal }, deps?: { readonly reportBytesWritten?: (jobId: string, photoId: string, bytesWritten: number) => void }) => Promise<{ kind: 'done'; bytesWritten: number } | { kind: 'failed'; code: 'Cancelled' | 'Integrity' | 'AccessRevoked' }>>(),
}));

const cryptoPoolMocks = vi.hoisted(() => {
  const pool = {
    size: 2,
    verifyShard: vi.fn(),
    decryptShard: vi.fn(),
    decryptShardWithTierKey: vi.fn(),
    getStats: vi.fn(async () => ({ size: 2, idle: 2, busy: 0, queued: 0 })),
    shutdown: vi.fn(),
  };
  return {
    pool,
    getCryptoPool: vi.fn(async () => pool),
  };
});

const broadcastState = vi.hoisted(() => ({
  channels: [] as Array<{
    readonly name: string;
    readonly listeners: Set<(event: MessageEvent<unknown>) => void>;
  }>,
}));

class TestBroadcastChannel {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(readonly name: string) {
    broadcastState.channels.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.listeners.delete(listener);
    }
  }

  postMessage(message: unknown): void {
    for (const channel of broadcastState.channels) {
      if (channel !== this && channel.name === this.name) {
        for (const listener of channel.listeners) {
          listener({ data: message } as MessageEvent<unknown>);
        }
      }
    }
  }

  close(): void {
    const index = broadcastState.channels.indexOf(this);
    if (index >= 0) {
      broadcastState.channels.splice(index, 1);
    }
  }
}

vi.mock('comlink', () => ({ expose: vi.fn(), proxy: <T>(value: T): T => value }));
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: vi.fn(),
    scope: 'test',
  }),
}));
vi.mock('../rust-crypto-core', () => rustMocks);
vi.mock('../crypto-pool', () => cryptoPoolMocks);
vi.mock('../coordinator/photo-pipeline', () => pipelineMocks);
vi.mock('../../lib/opfs-staging', () => ({
  createJobDir: vi.fn(async (jobId: string): Promise<void> => {
    opfsState.dirs.add(jobId);
  }),
  purgeJob: vi.fn(async (jobId: string): Promise<void> => {
    opfsState.dirs.delete(jobId);
    opfsState.snapshots.delete(jobId);
    opfsState.tempSnapshots.delete(jobId);
  }),
  gcStaleJobs: vi.fn(async (opts: { readonly nowMs: number; readonly maxAgeMs: number; readonly preserveJobIds?: ReadonlySet<string> }): Promise<{ purged: string[]; preserved: string[] }> => {
    const purged: string[] = [];
    const preserved: string[] = [];
    for (const [jobId, snapshot] of opfsState.snapshots) {
      if (opts.preserveJobIds?.has(jobId) === true) {
        preserved.push(jobId);
        continue;
      }
      const lastUpdatedAtMs = readSnapshotLastUpdatedAtMs(snapshot.body);
      if (opts.nowMs - lastUpdatedAtMs > opts.maxAgeMs) {
        opfsState.dirs.delete(jobId);
        opfsState.snapshots.delete(jobId);
        purged.push(jobId);
      } else {
        preserved.push(jobId);
      }
    }
    return { purged, preserved };
  }),
  writeSnapshot: vi.fn(async (jobId: string, body: Uint8Array, checksum: Uint8Array): Promise<void> => {
    opfsState.dirs.add(jobId);
    opfsState.snapshots.set(jobId, { body, checksum });
  }),
  readSnapshot: vi.fn(async (jobId: string): Promise<{ body: Uint8Array; checksum: Uint8Array } | null> => opfsState.snapshots.get(jobId) ?? null),
  jobExists: vi.fn(async (jobId: string): Promise<boolean> => opfsState.dirs.has(jobId)),
  listJobs: vi.fn(async (): Promise<string[]> => [...opfsState.dirs].sort()),
  writePhotoChunk: vi.fn(async (): Promise<void> => undefined),
  truncatePhotoTo: vi.fn(async (): Promise<void> => undefined),
  getPhotoFileLength: vi.fn(async (): Promise<number | null> => null),
  readPhotoStream: vi.fn(async (): Promise<ReadableStream<Uint8Array>> => new ReadableStream<Uint8Array>({ start(controller): void { controller.close(); } })),
}));

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';
import * as opfsStaging from '../../lib/opfs-staging';
import type { SourceStrategy } from '../coordinator/source-strategy';

const albumId = '018f0000-0000-7000-8000-000000000002';
const nowMs = 1_700_000_000_000;

interface CborMapEntry {
  readonly key: CborValue;
  readonly value: CborValue;
}

type CborValue =
  | { readonly kind: 'uint'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'array'; readonly value: CborValue[] }
  | { readonly kind: 'map'; readonly value: CborMapEntry[] }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' };

function validInput(tier = 3): StartJobInput {
  return {
    albumId,
    photos: [
      {
        photoId: '018f0000-0000-7000-8000-000000000101',
        filename: 'image-1.jpg',
        shards: [
          {
            shardId: new Uint8Array(16).fill(3),
            epochId: 7,
            tier,
            expectedHash: new Uint8Array(32).fill(4),
            declaredSize: 123,
          },
        ],
      },
    ],
  };
}

function uint(value: number): CborValue {
  return { kind: 'uint', value };
}

function map(value: readonly CborMapEntry[]): CborValue {
  return { kind: 'map', value: [...value] };
}

function mapEntry(key: number, value: CborValue): CborMapEntry {
  return { key: uint(key), value };
}

function encode(value: CborValue): Uint8Array {
  return cbor.encodeCbor(value);
}

function parse(bytes: Uint8Array): CborValue {
  return cbor.parseCbor(bytes);
}

function requiredMapValue(value: CborValue, key: number): CborValue {
  if (value.kind !== 'map') throw new Error('expected map');
  const entry = value.value.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  if (!entry) throw new Error('missing key');
  return entry.value;
}

function expectUint(value: CborValue): number {
  if (value.kind !== 'uint') throw new Error('expected uint');
  return value.value;
}

function expectBytes(value: CborValue): Uint8Array {
  if (value.kind !== 'bytes') throw new Error('expected bytes');
  return value.value;
}


function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function phaseCode(phase: DownloadPhase): number {
  return cbor.phaseCodeByPhase[phase];
}

function stateValue(phase: DownloadPhase): CborValue {
  if (phase === 'Cancelled') {
    return map([mapEntry(0, uint(phaseCode(phase))), mapEntry(2, { kind: 'bool', value: true })]);
  }
  return map([mapEntry(0, uint(phaseCode(phase)))]);
}

type TestPhotoStatus = 'pending' | 'inflight' | 'done' | 'failed' | 'skipped';

interface SnapshotPhotoSpec {
  readonly photoId: string;
  readonly status?: TestPhotoStatus;
  readonly bytesWritten?: number;
  readonly epochId?: number;
  readonly shardIds?: readonly Uint8Array[];
}

function snapshotBody(opts: {
  readonly jobIdBytes: Uint8Array;
  readonly phase: DownloadPhase;
  readonly createdAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly photoCount: number;
  readonly photos?: readonly SnapshotPhotoSpec[];
}): Uint8Array {
  const photos = opts.photos ?? Array.from({ length: opts.photoCount }, (): SnapshotPhotoSpec => ({
    photoId: '018f0000-0000-7000-8000-000000000101',
  }));
  return encode(map([
    mapEntry(0, uint(1)),
    mapEntry(1, { kind: 'bytes', value: opts.jobIdBytes }),
    mapEntry(2, { kind: 'bytes', value: uuidBytes(albumId) }),
    mapEntry(3, uint(opts.createdAtMs)),
    mapEntry(4, uint(opts.lastUpdatedAtMs)),
    mapEntry(5, stateValue(opts.phase)),
    mapEntry(6, { kind: 'array', value: photos.map((photo) => map([
      mapEntry(0, { kind: 'text', value: photo.photoId }),
      mapEntry(1, uint(photo.epochId ?? 7)),
      mapEntry(2, uint(3)),
      mapEntry(3, { kind: 'array', value: [...(photo.shardIds ?? [new Uint8Array(16).fill(3)])].map((shardId) => ({ kind: 'bytes', value: shardId })) }),
      mapEntry(4, { kind: 'array', value: [{ kind: 'bytes', value: new Uint8Array(32).fill(4) }] }),
      mapEntry(5, { kind: 'text', value: 'image-1.jpg' }),
      mapEntry(6, uint(123)),
    ])) }),
    mapEntry(7, { kind: 'array', value: photos.map((photo) => map([
      mapEntry(0, { kind: 'text', value: photo.photoId }),
      mapEntry(1, photoStatusValue(photo.status ?? 'pending')),
      mapEntry(2, uint(photo.bytesWritten ?? 0)),
      mapEntry(3, { kind: 'null' }),
      mapEntry(4, uint(0)),
    ])) }),
    mapEntry(8, { kind: 'array', value: [] }),
    mapEntry(9, { kind: 'null' }),
  ]));
}

function photoStatusValue(status: TestPhotoStatus): CborValue {
  const codeByStatus: Record<TestPhotoStatus, number> = { pending: 0, inflight: 1, done: 2, failed: 3, skipped: 4 };
  return map([mapEntry(0, uint(codeByStatus[status]))]);
}

function readPhotoBytesWritten(body: Uint8Array, photoId: string): number {
  const photos = requiredMapValue(parse(body), 7);
  if (photos.kind !== 'array') throw new Error('expected photos array');
  const photo = photos.value.find((candidate) => {
    const idValue = requiredMapValue(candidate, 0);
    return idValue.kind === 'text' && idValue.value === photoId;
  });
  if (!photo) throw new Error('photo not found');
  return expectUint(requiredMapValue(photo, 2));
}

function checksum(seed = 9): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function readSnapshotPhase(body: Uint8Array): DownloadPhase {
  const state = requiredMapValue(parse(body), 5);
  const code = expectUint(requiredMapValue(state, 0));
  const phase = Object.entries(cbor.phaseCodeByPhase).find(([, value]) => value === code)?.[0];
  if (!phase) throw new Error('phase not found');
  return phase as DownloadPhase;
}

function readSnapshotLastUpdatedAtMs(body: Uint8Array): number {
  return expectUint(requiredMapValue(parse(body), 4));
}

function eventKind(eventBytes: Uint8Array): number {
  return expectUint(requiredMapValue(parse(eventBytes), 0));
}


function transition(from: DownloadPhase, eventBytes: Uint8Array): DownloadPhase {
  const kind = eventKind(eventBytes);
  if (from === 'Idle' && kind === 0) return 'Preparing';
  if (from === 'Preparing' && kind === 1) return 'Running';
  if (from === 'Running' && kind === 2) return 'Paused';
  if (from === 'Paused' && kind === 3) return 'Running';
  if ((from === 'Running' || from === 'Preparing' || from === 'Paused' || from === 'Finalizing' || from === 'Errored') && kind === 5) return 'Errored';
  if (kind === 4) return 'Cancelled';
  if (from === 'Running' && kind === 6) return 'Finalizing';
  if (from === 'Finalizing' && kind === 7) return 'Done';
  throw new WorkerCryptoError(WorkerCryptoErrorCode.DownloadIllegalTransition, 'illegal transition');
}

async function startPreparingJob(worker: CoordinatorWorker): Promise<string> {
  const started = await worker.startJob(validInput());
  return started.jobId;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function testJobIdBytes(seed: number): Uint8Array {
  return new Uint8Array(16).fill(seed);
}

function photoSpecs(doneCount: number, totalCount: number): SnapshotPhotoSpec[] {
  return Array.from({ length: totalCount }, (_, index): SnapshotPhotoSpec => ({
    photoId: `photo-${index.toString().padStart(2, '0')}`,
    status: index < doneCount ? 'done' : 'pending',
    bytesWritten: index < doneCount ? 100 + index : 0,
  }));
}

function persistSnapshotJob(seed: number, phase: DownloadPhase, photos: readonly SnapshotPhotoSpec[]): string {
  const jobIdBytes = testJobIdBytes(seed);
  const jobId = hex(jobIdBytes);
  opfsState.dirs.add(jobId);
  opfsState.snapshots.set(jobId, {
    body: snapshotBody({
      jobIdBytes,
      phase,
      createdAtMs: nowMs - seed,
      lastUpdatedAtMs: nowMs + seed,
      photoCount: photos.length,
      photos,
    }),
    checksum: checksum(seed),
  });
  return jobId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  opfsState.dirs.clear();
  opfsState.snapshots.clear();
  opfsState.tempSnapshots.clear();
  broadcastState.channels.length = 0;
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
  vi.clearAllMocks();
  let planPhotoCount = 0;
  rustMocks.ensureRustReady.mockResolvedValue(undefined);
  rustMocks.rustBuildDownloadPlan.mockImplementation(async (input) => {
    if (input.photos.some((photo) => photo.shards.some((shard) => shard.tier !== 3))) {
      throw new WorkerCryptoError(WorkerCryptoErrorCode.DownloadInvalidPlan, 'invalid plan');
    }
    planPhotoCount = input.photos.length;
    return { planBytes: new Uint8Array([0x80 + input.photos.length]) };
  });
  rustMocks.rustInitDownloadSnapshot.mockImplementation(async (input) => ({
    bodyBytes: snapshotBody({
      jobIdBytes: input.jobId,
      phase: 'Idle',
      createdAtMs: input.nowMs,
      lastUpdatedAtMs: input.nowMs,
      photoCount: planPhotoCount,
    }),
    checksum: checksum(),
  }));
  rustMocks.rustApplyDownloadEvent.mockImplementation(async (stateBytes, eventBytes) => ({
    newStateBytes: encode(stateValue(transition(readSnapshotPhase(snapshotBody({
      jobIdBytes: new Uint8Array(16),
      phase: Object.entries(cbor.phaseCodeByPhase).find(([, value]) => value === expectUint(requiredMapValue(parse(stateBytes), 0)))?.[0] as DownloadPhase,
      createdAtMs: nowMs,
      lastUpdatedAtMs: nowMs,
      photoCount: 0,
    })), eventBytes))),
  }));
  rustMocks.rustCommitDownloadSnapshot.mockImplementation(async () => ({ checksum: checksum(7) }));
  rustMocks.rustVerifyDownloadSnapshot.mockResolvedValue({ valid: true });
  rustMocks.rustLoadDownloadSnapshot.mockImplementation(async (snapshotBytes) => ({ snapshotBytes, schemaVersionLoaded: 1 }));
  pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 123 });
  cbor.setCryptoPoolFactory(cryptoPoolMocks.getCryptoPool);
  cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CoordinatorWorker', () => {
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
    expect(events).toEqual(['Running', 'Running']);
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
      readonly getEpochSeed: (albumId: string, epochId: number) => Promise<Uint8Array>;
    }
    const fetchSpy = vi.fn(async (_ids: ReadonlyArray<string>, _signal: AbortSignal): Promise<Uint8Array[]> => [new Uint8Array([1, 2, 3])]);
    const resolveSpy = vi.fn(async (_albumId: string, _epochId: number): Promise<Uint8Array> => new Uint8Array(32).fill(9));
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
      expect(key).toHaveLength(32);
      return { kind: 'done', bytesWritten: 123 };
    });
    cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);

    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({ ...validInput(), source: customSource });
    await cbor.awaitScheduledDriver(worker, jobId);

    expect(cbor.getJobSource(worker, jobId)).toBe(customSource);
    expect(fetchSpy).toHaveBeenCalledWith(['shard-x'], expect.any(AbortSignal));
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
});













