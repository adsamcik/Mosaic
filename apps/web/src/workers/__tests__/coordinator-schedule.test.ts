/**
 * Coordinator ↔ ScheduleManager integration tests.
 *
 * Reuses the snapshot/CBOR mock harness from coordinator.worker.test.ts but
 * focuses on the Idle + schedule path: jobs that should NOT auto-dispatch,
 * forceStartJob bypass, updateJobSchedule re-encode + re-evaluation, and
 * restoration from the persisted snapshot after a worker restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCryptoError, WorkerCryptoErrorCode, type DownloadPhase, type StartJobInput } from '../types';
import type { DownloadSchedule } from '../../lib/download-schedule';

const rustMocks = vi.hoisted(() => ({
  ensureRustReady: vi.fn<() => Promise<void>>(),
  rustApplyDownloadEvent: vi.fn<(stateBytes: Uint8Array, eventBytes: Uint8Array) => Promise<{ newStateBytes: Uint8Array }>>(),
  rustBuildDownloadPlan: vi.fn<(input: { readonly photos: readonly { readonly shards: readonly { readonly tier: number }[] }[] }) => Promise<{ planBytes: Uint8Array }>>(),
  rustCommitDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array) => Promise<{ checksum: Uint8Array }>>(),
  rustInitDownloadSnapshot: vi.fn<(input: { readonly jobId: Uint8Array; readonly albumId: string; readonly planBytes: Uint8Array; readonly nowMs: number; readonly scopeKey: string; readonly schedule?: DownloadSchedule | null }) => Promise<{ bodyBytes: Uint8Array; checksum: Uint8Array }>>(),
  rustLoadDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array, checksum: Uint8Array) => Promise<{ snapshotBytes: Uint8Array; schemaVersionLoaded: number }>>(),
  rustVerifyDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array, checksum: Uint8Array) => Promise<{ valid: boolean }>>(),
}));

const opfsState = vi.hoisted(() => ({
  dirs: new Set<string>(),
  snapshots: new Map<string, { body: Uint8Array; checksum: Uint8Array }>(),
}));

const pipelineMocks = vi.hoisted(() => ({
  executePhotoTask: vi.fn<(input: { readonly signal: AbortSignal }) => Promise<{ kind: 'done'; bytesWritten: number }>>(),
}));

const cryptoPoolMocks = vi.hoisted(() => {
  const pool = {
    size: 1,
    verifyShard: vi.fn(),
    decryptShard: vi.fn(),
    decryptShardWithTierKey: vi.fn(),
    getStats: vi.fn(async () => ({ size: 1, idle: 1, busy: 0, queued: 0 })),
    shutdown: vi.fn(),
  };
  return { pool, getCryptoPool: vi.fn(async () => pool) };
});

const scheduleContextMock = vi.hoisted(() => ({
  ctx: {
    online: true,
    effectiveType: '4g',
    saveData: false,
    batteryLevel: 1,
    batteryCharging: true,
    visibilityState: 'visible' as const,
    nowMs: 1_700_000_000_000,
    localHour: 12,
    scheduledAtMs: 1_700_000_000_000,
  },
}));

vi.mock('comlink', () => ({ expose: vi.fn(), proxy: <T>(value: T): T => value }));
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }), child: vi.fn(), scope: 'test' }),
}));
vi.mock('../rust-crypto-core', () => rustMocks);
vi.mock('../crypto-pool', () => cryptoPoolMocks);
vi.mock('../coordinator/photo-pipeline', () => pipelineMocks);
vi.mock('../../lib/schedule-context', () => ({
  captureScheduleContext: vi.fn(async () => scheduleContextMock.ctx),
}));
vi.mock('../../lib/opfs-staging', () => ({
  createJobDir: vi.fn(async (jobId: string): Promise<void> => { opfsState.dirs.add(jobId); }),
  purgeJob: vi.fn(async (jobId: string): Promise<void> => { opfsState.dirs.delete(jobId); opfsState.snapshots.delete(jobId); }),
  gcStaleJobs: vi.fn(async () => ({ purged: [], preserved: [] })),
  writeSnapshot: vi.fn(async (jobId: string, body: Uint8Array, checksum: Uint8Array): Promise<void> => {
    opfsState.dirs.add(jobId);
    opfsState.snapshots.set(jobId, { body, checksum });
  }),
  readSnapshot: vi.fn(async (jobId: string) => opfsState.snapshots.get(jobId) ?? null),
  jobExists: vi.fn(async (jobId: string): Promise<boolean> => opfsState.dirs.has(jobId)),
  listJobs: vi.fn(async () => [...opfsState.dirs].sort()),
  writePhotoChunk: vi.fn(async (): Promise<void> => undefined),
  truncatePhotoTo: vi.fn(async (): Promise<void> => undefined),
  getPhotoFileLength: vi.fn(async () => null),
  readPhotoStream: vi.fn(async (): Promise<ReadableStream<Uint8Array>> => new ReadableStream<Uint8Array>({ start(c): void { c.close(); } })),
}));

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';

const albumId = '018f0000-0000-7000-8000-000000000002';
const nowMs = 1_700_000_000_000;

interface MapEntry { readonly key: CborValue; readonly value: CborValue }
type CborValue =
  | { readonly kind: 'uint'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'array'; readonly value: CborValue[] }
  | { readonly kind: 'map'; readonly value: MapEntry[] }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' };

function uint(v: number): CborValue { return { kind: 'uint', value: v }; }
function map(entries: readonly MapEntry[]): CborValue { return { kind: 'map', value: [...entries] }; }
function entry(key: number, value: CborValue): MapEntry { return { key: uint(key), value }; }
function encode(value: CborValue): Uint8Array { return cbor.encodeCbor(value); }
function parse(bytes: Uint8Array): CborValue { return cbor.parseCbor(bytes); }

function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function phaseStateValue(phase: DownloadPhase): CborValue {
  return map([entry(0, uint(cbor.phaseCodeByPhase[phase]))]);
}

interface SnapshotOpts {
  readonly jobIdBytes: Uint8Array;
  readonly phase: DownloadPhase;
  readonly nowMs: number;
  readonly scopeKey: string;
  readonly schedule?: DownloadSchedule | null;
}

function snapshotBody(opts: SnapshotOpts): Uint8Array {
  const fields: MapEntry[] = [
    entry(0, uint(3)),
    entry(1, { kind: 'bytes', value: opts.jobIdBytes }),
    entry(2, { kind: 'bytes', value: uuidBytes(albumId) }),
    entry(3, uint(opts.nowMs)),
    entry(4, uint(opts.nowMs)),
    entry(5, phaseStateValue(opts.phase)),
    entry(6, { kind: 'array', value: [
      map([
        entry(0, { kind: 'text', value: 'photo-1' }),
        entry(1, uint(7)),
        entry(2, uint(3)),
        entry(3, { kind: 'array', value: [{ kind: 'bytes', value: new Uint8Array(16).fill(3) }] }),
        entry(4, { kind: 'array', value: [{ kind: 'bytes', value: new Uint8Array(32).fill(4) }] }),
        entry(5, { kind: 'text', value: 'image-1.jpg' }),
        entry(6, uint(123)),
      ]),
    ] }),
    entry(7, { kind: 'array', value: [
      map([
        entry(0, { kind: 'text', value: 'photo-1' }),
        entry(1, map([entry(0, uint(0))])),
        entry(2, uint(0)),
        entry(3, { kind: 'null' }),
        entry(4, uint(0)),
      ]),
    ] }),
    entry(8, { kind: 'array', value: [] }),
    entry(9, { kind: 'null' }),
    entry(10, { kind: 'text', value: opts.scopeKey }),
  ];
  if (opts.schedule && opts.schedule.kind !== 'immediate') {
    fields.push(entry(11, encodeScheduleValue(opts.schedule)));
  }
  return encode(map(fields));
}

function encodeScheduleValue(schedule: DownloadSchedule): CborValue {
  const maxDelay: CborValue = schedule.maxDelayMs === undefined ? { kind: 'null' } : uint(schedule.maxDelayMs);
  switch (schedule.kind) {
    case 'wifi':
      return map([entry(0, uint(1)), entry(3, maxDelay)]);
    case 'wifi-charging':
      return map([entry(0, uint(2)), entry(3, maxDelay)]);
    case 'idle':
      return map([entry(0, uint(3)), entry(3, maxDelay)]);
    case 'window':
      return map([
        entry(0, uint(4)),
        entry(1, uint(schedule.windowStartHour ?? 0)),
        entry(2, uint(schedule.windowEndHour ?? 0)),
        entry(3, maxDelay),
      ]);
    case 'immediate':
      throw new Error('immediate not encoded');
  }
}

function checksum(seed = 9): Uint8Array { return new Uint8Array(32).fill(seed); }

function transition(from: DownloadPhase, kind: number): DownloadPhase {
  if (from === 'Idle' && kind === 0) return 'Preparing';
  if (from === 'Preparing' && kind === 1) return 'Running';
  if (from === 'Running' && kind === 6) return 'Finalizing';
  if (from === 'Finalizing' && kind === 7) return 'Done';
  if (kind === 4) return 'Cancelled';
  if ([2].includes(kind)) return 'Paused';
  if (kind === 3) return 'Running';
  if (kind === 5) return 'Errored';
  throw new WorkerCryptoError(WorkerCryptoErrorCode.DownloadIllegalTransition, 'illegal');
}

function readPhase(body: Uint8Array): DownloadPhase {
  const root = parse(body);
  if (root.kind !== 'map') throw new Error('not map');
  const stateEntry = root.value.find((e) => e.key.kind === 'uint' && e.key.value === 5);
  if (!stateEntry) throw new Error('no state');
  const stateMap = stateEntry.value;
  if (stateMap.kind !== 'map') throw new Error('state not map');
  const codeEntry = stateMap.value.find((e) => e.key.kind === 'uint' && e.key.value === 0);
  if (!codeEntry || codeEntry.value.kind !== 'uint') throw new Error('no code');
  const found = Object.entries(cbor.phaseCodeByPhase).find(([, v]) => v === codeEntry.value.value as unknown as number);
  if (!found) throw new Error('phase not found');
  return found[0] as DownloadPhase;
}

function validInput(schedule?: DownloadSchedule): StartJobInput {
  return {
    albumId,
    photos: [{
      photoId: '018f0000-0000-7000-8000-000000000101',
      filename: 'image-1.jpg',
      shards: [{
        shardId: new Uint8Array(16).fill(3),
        epochId: 7,
        tier: 3,
        expectedHash: new Uint8Array(32).fill(4),
        declaredSize: 123,
      }],
    }],
    ...(schedule ? { schedule } : {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  opfsState.dirs.clear();
  opfsState.snapshots.clear();
  vi.clearAllMocks();
  scheduleContextMock.ctx = {
    online: true, effectiveType: '4g', saveData: false,
    batteryLevel: 1, batteryCharging: true, visibilityState: 'visible',
    nowMs, localHour: 12, scheduledAtMs: nowMs,
  };
  rustMocks.ensureRustReady.mockResolvedValue(undefined);
  rustMocks.rustBuildDownloadPlan.mockImplementation(async () => ({ planBytes: new Uint8Array([0x81]) }));
  rustMocks.rustInitDownloadSnapshot.mockImplementation(async (input) => ({
    bodyBytes: snapshotBody({
      jobIdBytes: input.jobId,
      phase: 'Idle',
      nowMs: input.nowMs,
      scopeKey: input.scopeKey,
      schedule: input.schedule ?? null,
    }),
    checksum: checksum(),
  }));
  rustMocks.rustApplyDownloadEvent.mockImplementation(async (stateBytes, eventBytes) => {
    const stateRoot = parse(stateBytes);
    if (stateRoot.kind !== 'map') throw new Error('bad state');
    const codeEntry = stateRoot.value.find((e) => e.key.kind === 'uint' && e.key.value === 0);
    if (!codeEntry || codeEntry.value.kind !== 'uint') throw new Error('bad code');
    const fromPhase = Object.entries(cbor.phaseCodeByPhase).find(([, v]) => v === codeEntry.value.value as unknown as number)?.[0] as DownloadPhase;
    const eventRoot = parse(eventBytes);
    if (eventRoot.kind !== 'map') throw new Error('bad event');
    const kindEntry = eventRoot.value.find((e) => e.key.kind === 'uint' && e.key.value === 0);
    if (!kindEntry || kindEntry.value.kind !== 'uint') throw new Error('bad kind');
    const next = transition(fromPhase, kindEntry.value.value);
    return { newStateBytes: encode(phaseStateValue(next)) };
  });
  rustMocks.rustCommitDownloadSnapshot.mockImplementation(async () => ({ checksum: checksum(7) }));
  rustMocks.rustVerifyDownloadSnapshot.mockResolvedValue({ valid: true });
  rustMocks.rustLoadDownloadSnapshot.mockImplementation(async (snapshotBytes) => ({ snapshotBytes, schemaVersionLoaded: 3 }));
  pipelineMocks.executePhotoTask.mockResolvedValue({ kind: 'done', bytesWritten: 123 });
  cbor.setCryptoPoolFactory(cryptoPoolMocks.getCryptoPool);
  cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CoordinatorWorker schedule wiring', () => {
  it('immediate schedule dispatches inline (Running after startJob)', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'immediate' }));
    const job = await w.getJob(jobId);
    expect(job?.phase).toBe('Running');
    expect(job?.schedule).toBeNull();
  });

  it('non-immediate schedule keeps job Idle and registers with manager', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const schedule: DownloadSchedule = { kind: 'wifi' };
    const { jobId } = await w.startJob(validInput(schedule));
    const job = await w.getJob(jobId);
    expect(job?.phase).toBe('Idle');
    expect(job?.schedule).toEqual({ kind: 'wifi' });
    expect(cbor.getScheduleManager(w)?.size()).toBe(1);
  });

  it('wifi schedule with bad context stays Idle until conditions allow', async () => {
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '2g' };
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'wifi' }));
    await cbor.getScheduleManager(w)?.evaluateAll();
    expect((await w.getJob(jobId))?.phase).toBe('Idle');
    // Flip to 4g and re-evaluate → dispatched.
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '4g' };
    await cbor.getScheduleManager(w)?.evaluateAll();
    // `dispatchScheduledJob` is fire-and-forget; let microtasks settle.
    await vi.waitFor(async () => {
      const phase = (await w.getJob(jobId))?.phase;
      expect(phase).not.toBe('Idle');
    });
  });

  it('forceStartJob bypasses the manager and dispatches Idle scheduled job', async () => {
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '2g' };
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'wifi' }));
    expect(cbor.getScheduleManager(w)?.size()).toBe(1);
    await w.forceStartJob(jobId);
    expect(cbor.getScheduleManager(w)?.size()).toBe(0);
    await vi.waitFor(async () => {
      const phase = (await w.getJob(jobId))?.phase;
      expect(phase).not.toBe('Idle');
    });
  });

  it('forceStartJob is a no-op for unknown jobs (idempotent)', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    await expect(w.forceStartJob('deadbeef'.repeat(4))).resolves.toBeUndefined();
  });

  it('updateJobSchedule re-encodes snapshot and re-registers with manager', async () => {
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '2g' };
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'wifi' }));
    expect((await w.getJob(jobId))?.schedule).toEqual({ kind: 'wifi' });

    // Update to wifi-charging — snapshot key 11 must change but job stays Idle.
    await w.updateJobSchedule(jobId, { kind: 'wifi-charging' });
    const job = await w.getJob(jobId);
    expect(job?.phase).toBe('Idle');
    expect(job?.schedule).toEqual({ kind: 'wifi-charging' });
    expect(cbor.getScheduleManager(w)?.size()).toBe(1);
  });

  it('updateJobSchedule with null clears gate and dispatches', async () => {
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '2g' };
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'wifi' }));
    await w.updateJobSchedule(jobId, null);
    await vi.waitFor(async () => {
      const phase = (await w.getJob(jobId))?.phase;
      expect(phase).not.toBe('Idle');
    });
    expect(cbor.getScheduleManager(w)?.size()).toBe(0);
  });

  it('updateJobSchedule throws JobNotFound for unknown jobs', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    await expect(w.updateJobSchedule('deadbeef'.repeat(4), { kind: 'wifi' }))
      .rejects.toMatchObject({ code: WorkerCryptoErrorCode.JobNotFound });
  });

  it('cancelJob removes a scheduled job from the manager', async () => {
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '2g' };
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'wifi' }));
    expect(cbor.getScheduleManager(w)?.size()).toBe(1);
    await w.cancelJob(jobId, { soft: false });
    expect(cbor.getScheduleManager(w)?.size()).toBe(0);
  });

  it('reconstructed scheduled jobs re-enter the manager on startup', async () => {
    scheduleContextMock.ctx = { ...scheduleContextMock.ctx, effectiveType: '2g' };
    const w1 = new CoordinatorWorker();
    await w1.initialize({ nowMs });
    const { jobId } = await w1.startJob(validInput({ kind: 'wifi' }));
    expect((await w1.getJob(jobId))?.phase).toBe('Idle');
    // New worker reads OPFS → reconciles → re-arms manager.
    const w2 = new CoordinatorWorker();
    await w2.initialize({ nowMs });
    expect(cbor.getScheduleManager(w2)?.size()).toBe(1);
    const restored = await w2.getJob(jobId);
    expect(restored?.phase).toBe('Idle');
    expect(restored?.schedule).toEqual({ kind: 'wifi' });
  });

  it('JobSummary surfaces the manager last-known evaluation', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob(validInput({ kind: 'wifi' }));
    cbor.setLastEvaluation(w, jobId, { canStart: false, reason: 'connection too slow', retryAfterMs: 30_000 });
    const job = await w.getJob(jobId);
    expect(job?.scheduleEvaluation).toEqual({ canStart: false, reason: 'connection too slow', retryAfterMs: 30_000 });
  });
});
