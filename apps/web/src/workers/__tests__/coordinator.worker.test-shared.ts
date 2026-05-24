/**
 * Shared test infrastructure for coordinator.worker.test.ts and its split siblings.
 *
 * This module exports:
 *   - vi.hoisted() mock state (rustMocks, opfsState, pipelineMocks, cryptoPoolMocks, broadcastState)
 *   - TestBroadcastChannel class
 *   - Mock factory builders (consumed by each test file's vi.mock(...) calls)
 *   - Constants, CBOR helpers, snapshot builders, transition reducer, and test scaffolding
 *   - registerCoordinatorHooks(cbor): installs the shared beforeEach/afterEach hooks
 *
 * NOTE on vitest hoisting:
 *   `vi.mock(...)` MUST be declared in each test file at top-level (vitest hoists those
 *   per-file). Test files import the mock state + factories from this module and call
 *   `vi.mock('../module', () => factory(state))`. Lazy factory evaluation means the
 *   imported state is initialized by the time the factory runs.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import {
  WorkerCryptoError,
  WorkerCryptoErrorCode,
  type DownloadPhase,
  type StartJobInput,
} from '../types';
import type { CoordinatorWorker, __coordinatorWorkerTestUtils } from '../coordinator.worker';

// ---------------------------------------------------------------------------
// Shared mock state — plain module-scope objects.
//
// We do NOT use vi.hoisted() here because vitest disallows
// `export const x = vi.hoisted(...)`. Plain module-scope state works because
// vi.mock(...) factories are evaluated LAZILY (when the mocked module is
// first imported), by which time these exports are fully initialized.
// ---------------------------------------------------------------------------

export const rustMocks = {
  ensureRustReady: vi.fn<() => Promise<void>>(),
  rustApplyDownloadEvent: vi.fn<(stateBytes: Uint8Array, eventBytes: Uint8Array) => Promise<{ newStateBytes: Uint8Array }>>(),
  rustBuildDownloadPlan: vi.fn<(input: { readonly photos: readonly { readonly shards: readonly { readonly tier: number }[] }[] }) => Promise<{ planBytes: Uint8Array }>>(),
  rustCommitDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array) => Promise<{ checksum: Uint8Array }>>(),
  rustInitDownloadSnapshot: vi.fn<(input: { readonly jobId: Uint8Array; readonly albumId: string; readonly planBytes: Uint8Array; readonly nowMs: number; readonly scopeKey: string }) => Promise<{ bodyBytes: Uint8Array; checksum: Uint8Array }>>(),
  rustLoadDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array, checksum: Uint8Array) => Promise<{ snapshotBytes: Uint8Array; schemaVersionLoaded: number }>>(),
  rustVerifyDownloadSnapshot: vi.fn<(snapshotBytes: Uint8Array, checksum: Uint8Array) => Promise<{ valid: boolean }>>(),
};

export const opfsState = {
  dirs: new Set<string>(),
  snapshots: new Map<string, { body: Uint8Array; checksum: Uint8Array }>(),
  tempSnapshots: new Map<string, Uint8Array>(),
};

export const pipelineMocks = {
  decryptShardWithResolvedKey: vi.fn(async (_pool: unknown, bytes: Uint8Array): Promise<Uint8Array> => bytes),
  executePhotoTask: vi.fn<(input: { readonly signal: AbortSignal }, deps?: { readonly pool?: unknown; readonly reportBytesWritten?: (jobId: string, photoId: string, bytesWritten: number) => void }) => Promise<{ kind: 'done'; bytesWritten: number } | { kind: 'failed'; code: 'Cancelled' | 'Integrity' | 'AccessRevoked' }>>(),
};

const _cryptoPool = {
  size: 2,
  verifyShard: vi.fn(),
  decryptShardWithTierKey: vi.fn(),
  decryptShardWithEpochHandle: vi.fn(),
  decryptShardWithLinkTierHandle: vi.fn(),
  getStats: vi.fn(async () => ({ size: 2, idle: 2, busy: 0, queued: 0 })),
  shutdown: vi.fn(),
};

export const cryptoPoolMocks = {
  pool: _cryptoPool,
  getCryptoPool: vi.fn(async () => _cryptoPool),
};

export const broadcastState = {
  channels: [] as Array<{
    readonly name: string;
    readonly listeners: Set<(event: MessageEvent<unknown>) => void>;
  }>,
};

export class TestBroadcastChannel {
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

// ---------------------------------------------------------------------------
// Mock factory builders (called by each test file's vi.mock(...) declarations).
// ---------------------------------------------------------------------------

export function makeComlinkMock(): Record<string, unknown> {
  return {
    expose: vi.fn(),
    proxy: <T>(value: T): T => value,
    releaseProxy: Symbol.for('Comlink.releaseProxy'),
    transferHandlers: new Map(),
  };
}

export function makeLoggerMock(): Record<string, unknown> {
  return {
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
      child: vi.fn(),
      scope: 'test',
    }),
  };
}

export function makeOpfsStagingMock(): Record<string, unknown> {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Constants and CBOR helpers.
// ---------------------------------------------------------------------------

export const albumId = '018f0000-0000-7000-8000-000000000002';
export const nowMs = 1_700_000_000_000;

export interface CborMapEntry {
  readonly key: CborValue;
  readonly value: CborValue;
}

export type CborValue =
  | { readonly kind: 'uint'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'array'; readonly value: CborValue[] }
  | { readonly kind: 'map'; readonly value: CborMapEntry[] }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' };

export function validInput(tier = 3): StartJobInput {
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

export function uint(value: number): CborValue {
  return { kind: 'uint', value };
}

export function map(value: readonly CborMapEntry[]): CborValue {
  return { kind: 'map', value: [...value] };
}

export function mapEntry(key: number, value: CborValue): CborMapEntry {
  return { key: uint(key), value };
}

/** Lazily-bound CBOR codec set by registerCoordinatorHooks(). */
let cborRef: typeof __coordinatorWorkerTestUtils | null = null;

function getCbor(): typeof __coordinatorWorkerTestUtils {
  if (!cborRef) throw new Error('coordinator hooks not registered; call registerCoordinatorHooks(cbor) first');
  return cborRef;
}

export function encode(value: CborValue): Uint8Array {
  return getCbor().encodeCbor(value);
}

export function parse(bytes: Uint8Array): CborValue {
  return getCbor().parseCbor(bytes);
}

export function requiredMapValue(value: CborValue, key: number): CborValue {
  if (value.kind !== 'map') throw new Error('expected map');
  const entry = value.value.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  if (!entry) throw new Error('missing key');
  return entry.value;
}

export function expectUint(value: CborValue): number {
  if (value.kind !== 'uint') throw new Error('expected uint');
  return value.value;
}

export function expectBytes(value: CborValue): Uint8Array {
  if (value.kind !== 'bytes') throw new Error('expected bytes');
  return value.value;
}

export function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function phaseCode(phase: DownloadPhase): number {
  return getCbor().phaseCodeByPhase[phase];
}

export function stateValue(phase: DownloadPhase): CborValue {
  if (phase === 'Cancelled') {
    return map([mapEntry(0, uint(phaseCode(phase))), mapEntry(2, { kind: 'bool', value: true })]);
  }
  return map([mapEntry(0, uint(phaseCode(phase)))]);
}

export type TestPhotoStatus = 'pending' | 'inflight' | 'done' | 'failed' | 'skipped';

export interface SnapshotPhotoSpec {
  readonly photoId: string;
  readonly status?: TestPhotoStatus;
  readonly bytesWritten?: number;
  readonly epochId?: number;
  readonly shardIds?: readonly Uint8Array[];
}

export function snapshotBody(opts: {
  readonly jobIdBytes: Uint8Array;
  readonly phase: DownloadPhase;
  readonly createdAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly photoCount: number;
  readonly photos?: readonly SnapshotPhotoSpec[];
  readonly scopeKey?: string;
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
    ...(opts.scopeKey === undefined
      ? []
      : [mapEntry(10, { kind: 'text' as const, value: opts.scopeKey })]),
  ]));
}

export function photoStatusValue(status: TestPhotoStatus): CborValue {
  const codeByStatus: Record<TestPhotoStatus, number> = { pending: 0, inflight: 1, done: 2, failed: 3, skipped: 4 };
  return map([mapEntry(0, uint(codeByStatus[status]))]);
}

export function readPhotoBytesWritten(body: Uint8Array, photoId: string): number {
  const photos = requiredMapValue(parse(body), 7);
  if (photos.kind !== 'array') throw new Error('expected photos array');
  const photo = photos.value.find((candidate) => {
    const idValue = requiredMapValue(candidate, 0);
    return idValue.kind === 'text' && idValue.value === photoId;
  });
  if (!photo) throw new Error('photo not found');
  return expectUint(requiredMapValue(photo, 2));
}

export function checksum(seed = 9): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

export function readSnapshotPhase(body: Uint8Array): DownloadPhase {
  const state = requiredMapValue(parse(body), 5);
  const code = expectUint(requiredMapValue(state, 0));
  const phase = Object.entries(getCbor().phaseCodeByPhase).find(([, value]) => value === code)?.[0];
  if (!phase) throw new Error('phase not found');
  return phase as DownloadPhase;
}

export function readSnapshotLastUpdatedAtMs(body: Uint8Array): number {
  return expectUint(requiredMapValue(parse(body), 4));
}

export function eventKind(eventBytes: Uint8Array): number {
  return expectUint(requiredMapValue(parse(eventBytes), 0));
}

export function transition(from: DownloadPhase, eventBytes: Uint8Array): DownloadPhase {
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

export async function startPreparingJob(worker: CoordinatorWorker): Promise<string> {
  const started = await worker.startJob(validInput());
  return started.jobId;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function testJobIdBytes(seed: number): Uint8Array {
  return new Uint8Array(16).fill(seed);
}

export function photoSpecs(doneCount: number, totalCount: number): SnapshotPhotoSpec[] {
  return Array.from({ length: totalCount }, (_, index): SnapshotPhotoSpec => ({
    photoId: `photo-${index.toString().padStart(2, '0')}`,
    status: index < doneCount ? 'done' : 'pending',
    bytesWritten: index < doneCount ? 100 + index : 0,
  }));
}

export function persistSnapshotJob(
  seed: number,
  phase: DownloadPhase,
  photos: readonly SnapshotPhotoSpec[],
  options: { readonly scopeKey?: string; readonly lastUpdatedAtMs?: number } = {},
): string {
  const jobIdBytes = testJobIdBytes(seed);
  const jobId = hex(jobIdBytes);
  opfsState.dirs.add(jobId);
  opfsState.snapshots.set(jobId, {
    body: snapshotBody({
      jobIdBytes,
      phase,
      createdAtMs: nowMs - seed,
      lastUpdatedAtMs: options.lastUpdatedAtMs ?? nowMs + seed,
      photoCount: photos.length,
      photos,
      ...(options.scopeKey === undefined ? {} : { scopeKey: options.scopeKey }),
    }),
    checksum: checksum(seed),
  });
  return jobId;
}

// ---------------------------------------------------------------------------
// Shared beforeEach/afterEach hook installer.
// Each test file calls registerCoordinatorHooks(cbor) at module top-level.
// ---------------------------------------------------------------------------

export function registerCoordinatorHooks(cbor: typeof __coordinatorWorkerTestUtils): void {
  cborRef = cbor;

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
        scopeKey: input.scopeKey,
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
}
