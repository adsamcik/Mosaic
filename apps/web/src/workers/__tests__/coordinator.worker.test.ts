import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';
import * as opfsStaging from '../../lib/opfs-staging';

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

function snapshotBody(opts: {
  readonly jobIdBytes: Uint8Array;
  readonly phase: DownloadPhase;
  readonly createdAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly photoCount: number;
}): Uint8Array {
  return encode(map([
    mapEntry(0, uint(1)),
    mapEntry(1, { kind: 'bytes', value: opts.jobIdBytes }),
    mapEntry(2, { kind: 'bytes', value: uuidBytes(albumId) }),
    mapEntry(3, uint(opts.createdAtMs)),
    mapEntry(4, uint(opts.lastUpdatedAtMs)),
    mapEntry(5, stateValue(opts.phase)),
    mapEntry(6, { kind: 'array', value: [] }),
    mapEntry(7, { kind: 'array', value: Array.from({ length: opts.photoCount }, () => map([
      mapEntry(0, { kind: 'text', value: '018f0000-0000-7000-8000-000000000101' }),
      mapEntry(1, map([mapEntry(0, uint(0))])),
      mapEntry(2, uint(0)),
      mapEntry(3, { kind: 'null' }),
      mapEntry(4, uint(0)),
    ])) }),
    mapEntry(8, { kind: 'array', value: [] }),
    mapEntry(9, { kind: 'null' }),
  ]));
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
  if (kind === 4) return 'Cancelled';
  if (from === 'Running' && kind === 6) return 'Finalizing';
  if (from === 'Finalizing' && kind === 7) return 'Done';
  throw new WorkerCryptoError(WorkerCryptoErrorCode.DownloadIllegalTransition, 'illegal transition');
}

async function startPreparingJob(worker: CoordinatorWorker): Promise<string> {
  const started = await worker.startJob(validInput());
  return started.jobId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  opfsState.dirs.clear();
  opfsState.snapshots.clear();
  opfsState.tempSnapshots.clear();
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
});

describe('CoordinatorWorker', () => {
  it('initializes empty state', async () => {
    const worker = new CoordinatorWorker();
    await expect(worker.initialize({ nowMs })).resolves.toEqual({ reconstructedJobs: 0 });
    await expect(worker.listJobs()).resolves.toEqual([]);
  });

  it('starts a job and transitions Idle to Preparing', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob(validInput());
    expect(jobId).toMatch(/^[0-9a-f]{32}$/u);
    const jobs = await worker.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.phase).toBe('Preparing');
    expect(jobs[0]?.photoCounts.pending).toBe(1);
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

  it('cancel-hard purges OPFS and removes the job', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    await worker.cancelJob(jobId, { soft: false });
    await expect(opfsStaging.jobExists(jobId)).resolves.toBe(false);
    await expect(worker.listJobs()).resolves.toEqual([]);
  });

  it('ignores torn temporary snapshots while committing a later transition', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const jobId = await startPreparingJob(worker);
    opfsState.tempSnapshots.set(jobId, new Uint8Array([0xff]));
    await worker.sendEvent(jobId, { kind: 'PlanReady' });
    expect(readSnapshotPhase(opfsState.snapshots.get(jobId)?.body ?? new Uint8Array())).toBe('Running');
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
    expect(events).toEqual(['Preparing', 'Running']);
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
});
