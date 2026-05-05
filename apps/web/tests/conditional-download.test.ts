/**
 * End-to-end conditional-download flow.
 *
 * Drives the public coordinator API through the realistic user path:
 *   1. Picker confirms keepOffline + wifi schedule → startJob.
 *   2. Bad context (effectiveType === '2g') keeps job Idle.
 *   3. Context flips to '4g' → re-evaluation dispatches the job.
 *   4. Force-start (Start now) bypasses while still gated.
 *   5. Edit schedule + change kind triggers a re-evaluation.
 *
 * Mocks the WASM Rust facade + crypto pool + photo pipeline to focus on
 * the wiring, not the cryptographic plumbing (which has dedicated tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadSchedule } from '../src/lib/download-schedule';

const rustMocks = vi.hoisted(() => ({
  ensureRustReady: vi.fn(async () => undefined),
  rustApplyDownloadEvent: vi.fn(),
  rustBuildDownloadPlan: vi.fn(async () => ({ planBytes: new Uint8Array([0x81]) })),
  rustCommitDownloadSnapshot: vi.fn(async () => ({ checksum: new Uint8Array(32).fill(7) })),
  rustInitDownloadSnapshot: vi.fn(),
  rustLoadDownloadSnapshot: vi.fn(async (snapshotBytes: Uint8Array) => ({ snapshotBytes, schemaVersionLoaded: 3 })),
  rustVerifyDownloadSnapshot: vi.fn(async () => ({ valid: true })),
}));

const opfsState = vi.hoisted(() => ({
  dirs: new Set<string>(),
  snapshots: new Map<string, { body: Uint8Array; checksum: Uint8Array }>(),
}));

const pipelineMocks = vi.hoisted(() => ({
  executePhotoTask: vi.fn(async () => ({ kind: 'done' as const, bytesWritten: 100 })),
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

const ctx = vi.hoisted(() => ({
  value: {
    online: true,
    effectiveType: '2g',
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
vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }), child: vi.fn(), scope: 'test' }),
}));
vi.mock('../src/workers/rust-crypto-core', () => rustMocks);
vi.mock('../src/workers/crypto-pool', () => cryptoPoolMocks);
vi.mock('../src/workers/coordinator/photo-pipeline', () => pipelineMocks);
vi.mock('../src/lib/schedule-context', () => ({
  captureScheduleContext: vi.fn(async () => ctx.value),
}));
vi.mock('../src/lib/opfs-staging', () => ({
  createJobDir: vi.fn(async (jobId: string) => { opfsState.dirs.add(jobId); }),
  purgeJob: vi.fn(async (jobId: string) => { opfsState.dirs.delete(jobId); opfsState.snapshots.delete(jobId); }),
  gcStaleJobs: vi.fn(async () => ({ purged: [], preserved: [] })),
  writeSnapshot: vi.fn(async (jobId: string, body: Uint8Array, checksum: Uint8Array) => {
    opfsState.dirs.add(jobId);
    opfsState.snapshots.set(jobId, { body, checksum });
  }),
  readSnapshot: vi.fn(async (jobId: string) => opfsState.snapshots.get(jobId) ?? null),
  jobExists: vi.fn(async (jobId: string) => opfsState.dirs.has(jobId)),
  listJobs: vi.fn(async () => [...opfsState.dirs].sort()),
  writePhotoChunk: vi.fn(async () => undefined),
  truncatePhotoTo: vi.fn(async () => undefined),
  getPhotoFileLength: vi.fn(async () => null),
  readPhotoStream: vi.fn(async () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } })),
}));

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../src/workers/coordinator.worker';

const albumId = '018f0000-0000-7000-8000-000000000002';
const nowMs = 1_700_000_000_000;

interface E { key: V; value: V }
type V =
  | { kind: 'uint'; value: number }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'text'; value: string }
  | { kind: 'array'; value: V[] }
  | { kind: 'map'; value: E[] }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

const u = (n: number): V => ({ kind: 'uint', value: n });
const m = (entries: E[]): V => ({ kind: 'map', value: entries });
const e = (k: number, v: V): E => ({ key: u(k), value: v });

function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function snapshotIdle(jobId: Uint8Array, scopeKey: string, schedule: DownloadSchedule | null): Uint8Array {
  const fields: E[] = [
    e(0, u(3)), e(1, { kind: 'bytes', value: jobId }), e(2, { kind: 'bytes', value: uuidBytes(albumId) }),
    e(3, u(nowMs)), e(4, u(nowMs)),
    e(5, m([e(0, u(0))])), // Idle
    e(6, { kind: 'array', value: [m([
      e(0, { kind: 'text', value: 'p1' }),
      e(1, u(7)), e(2, u(3)),
      e(3, { kind: 'array', value: [{ kind: 'bytes', value: new Uint8Array(16).fill(3) }] }),
      e(4, { kind: 'array', value: [{ kind: 'bytes', value: new Uint8Array(32).fill(4) }] }),
      e(5, { kind: 'text', value: 'image-1.jpg' }),
      e(6, u(123)),
    ])] }),
    e(7, { kind: 'array', value: [m([
      e(0, { kind: 'text', value: 'p1' }),
      e(1, m([e(0, u(0))])),
      e(2, u(0)), e(3, { kind: 'null' }), e(4, u(0)),
    ])] }),
    e(8, { kind: 'array', value: [] }),
    e(9, { kind: 'null' }),
    e(10, { kind: 'text', value: scopeKey }),
  ];
  if (schedule && schedule.kind !== 'immediate') {
    const md: V = schedule.maxDelayMs === undefined ? { kind: 'null' } : u(schedule.maxDelayMs);
    let inner: V;
    if (schedule.kind === 'wifi') inner = m([e(0, u(1)), e(3, md)]);
    else if (schedule.kind === 'wifi-charging') inner = m([e(0, u(2)), e(3, md)]);
    else if (schedule.kind === 'idle') inner = m([e(0, u(3)), e(3, md)]);
    else inner = m([
      e(0, u(4)),
      e(1, u(schedule.windowStartHour ?? 0)),
      e(2, u(schedule.windowEndHour ?? 0)),
      e(3, md),
    ]);
    fields.push(e(11, inner));
  }
  return cbor.encodeCbor(m(fields));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  opfsState.dirs.clear();
  opfsState.snapshots.clear();
  ctx.value = { ...ctx.value, effectiveType: '2g' };
  rustMocks.rustInitDownloadSnapshot.mockImplementation(async (input: { jobId: Uint8Array; scopeKey: string; schedule?: DownloadSchedule | null }) => ({
    bodyBytes: snapshotIdle(input.jobId, input.scopeKey, input.schedule ?? null),
    checksum: new Uint8Array(32).fill(9),
  }));
  rustMocks.rustApplyDownloadEvent.mockImplementation(async (stateBytes: Uint8Array, eventBytes: Uint8Array) => {
    const stateRoot = cbor.parseCbor(stateBytes);
    const eventRoot = cbor.parseCbor(eventBytes);
    if (stateRoot.kind !== 'map' || eventRoot.kind !== 'map') throw new Error('bad');
    const codeEntry = stateRoot.value.find((p) => p.key.kind === 'uint' && p.key.value === 0);
    const kindEntry = eventRoot.value.find((p) => p.key.kind === 'uint' && p.key.value === 0);
    if (!codeEntry || codeEntry.value.kind !== 'uint' || !kindEntry || kindEntry.value.kind !== 'uint') throw new Error('bad');
    const fromCode = codeEntry.value.value;
    const evKind = kindEntry.value.value;
    let nextCode = fromCode;
    if (fromCode === 0 && evKind === 0) nextCode = 1; // Idle + StartRequested -> Preparing
    else if (fromCode === 1 && evKind === 1) nextCode = 2; // Preparing + PlanReady -> Running
    else if (fromCode === 2 && evKind === 6) nextCode = 4; // Running + AllPhotosDone -> Finalizing
    else if (fromCode === 4 && evKind === 7) nextCode = 5; // Finalizing + FinalizationDone -> Done
    else if (evKind === 4) nextCode = 7; // Cancel
    return { newStateBytes: cbor.encodeCbor(m([e(0, u(nextCode))])) };
  });
  cbor.setCryptoPoolFactory(cryptoPoolMocks.getCryptoPool);
  cbor.setExecutePhotoTask(pipelineMocks.executePhotoTask);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('conditional download e2e', () => {
  it('keepOffline + wifi schedule: stays scheduled until conditions allow', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });

    // 1. Picker → startJob with wifi schedule.
    const { jobId } = await w.startJob({
      albumId,
      photos: [{
        photoId: '018f0000-0000-7000-8000-000000000101',
        filename: 'image-1.jpg',
        shards: [{ shardId: new Uint8Array(16).fill(3), epochId: 7, tier: 3, expectedHash: new Uint8Array(32).fill(4), declaredSize: 123 }],
      }],
      schedule: { kind: 'wifi' },
    });

    // 2. Bad context → still Idle after manager evaluates.
    await cbor.getScheduleManager(w)?.evaluateAll();
    expect((await w.getJob(jobId))?.phase).toBe('Idle');

    // 3. Flip to 4g → re-evaluation dispatches.
    ctx.value = { ...ctx.value, effectiveType: '4g' };
    await cbor.getScheduleManager(w)?.evaluateAll();
    await vi.waitFor(async () => {
      expect((await w.getJob(jobId))?.phase).not.toBe('Idle');
    });
    // Manager has dropped the job.
    expect(cbor.getScheduleManager(w)?.size()).toBe(0);
  });

  it('Start now bypasses the gate (forceStartJob)', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob({
      albumId,
      photos: [{
        photoId: '018f0000-0000-7000-8000-000000000101',
        filename: 'image-1.jpg',
        shards: [{ shardId: new Uint8Array(16).fill(3), epochId: 7, tier: 3, expectedHash: new Uint8Array(32).fill(4), declaredSize: 123 }],
      }],
      schedule: { kind: 'wifi' },
    });
    expect(cbor.getScheduleManager(w)?.size()).toBe(1);
    await w.forceStartJob(jobId);
    await vi.waitFor(async () => {
      expect((await w.getJob(jobId))?.phase).not.toBe('Idle');
    });
  });

  it('Edit schedule (updateJobSchedule) triggers re-evaluation', async () => {
    const w = new CoordinatorWorker();
    await w.initialize({ nowMs });
    const { jobId } = await w.startJob({
      albumId,
      photos: [{
        photoId: '018f0000-0000-7000-8000-000000000101',
        filename: 'image-1.jpg',
        shards: [{ shardId: new Uint8Array(16).fill(3), epochId: 7, tier: 3, expectedHash: new Uint8Array(32).fill(4), declaredSize: 123 }],
      }],
      schedule: { kind: 'wifi' },
    });

    // Switch to a window-kind schedule whose context evaluation will allow.
    ctx.value = { ...ctx.value, effectiveType: '4g', localHour: 12 };
    await w.updateJobSchedule(jobId, { kind: 'window', windowStartHour: 0, windowEndHour: 23 });
    await vi.waitFor(async () => {
      expect((await w.getJob(jobId))?.phase).not.toBe('Idle');
    });
    expect((await w.getJob(jobId))?.schedule).toEqual({ kind: 'window', windowStartHour: 0, windowEndHour: 23 });
  });
});
