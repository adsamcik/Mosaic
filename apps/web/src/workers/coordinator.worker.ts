/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { createLogger } from '../lib/logger';
import * as opfsStaging from '../lib/opfs-staging';
import {
  ensureRustReady,
  rustApplyDownloadEvent,
  rustBuildDownloadPlan,
  rustCommitDownloadSnapshot,
  rustInitDownloadSnapshot,
  rustLoadDownloadSnapshot,
  rustVerifyDownloadSnapshot,
} from './rust-crypto-core';
import { WorkerCryptoError, WorkerCryptoErrorCode } from './types';
import type {
  CoordinatorWorkerApi,
  DownloadBuildPlanInput,
  DownloadErrorReason,
  DownloadEventInput,
  DownloadFailureView,
  DownloadJobStateView,
  DownloadJobsBroadcastMessage,
  DownloadPhase,
  DownloadPhotoCounts,
  DownloadPhotoStateView,
  JobProgressEvent,
  JobSummary,
  StartJobInput,
} from './types';

const log = createLogger('CoordinatorWorker');
const CHANNEL_NAME = 'mosaic-download-jobs';
const JOB_ID_HEX_BYTES = 16;
const CHECKSUM_BYTES = 32;

interface InMemoryJob {
  readonly jobId: string;
  readonly albumId: string;
  snapshotBytes: Uint8Array;
  snapshotChecksum: Uint8Array;
  state: DownloadJobStateView;
  photos: DownloadPhotoStateView[];
  failureLog: DownloadFailureView[];
  createdAtMs: number;
  lastUpdatedAtMs: number;
}

type SubscriptionCallback = (event: JobProgressEvent) => void;

type CborValue =
  | { readonly kind: 'uint'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'array'; readonly value: CborValue[] }
  | { readonly kind: 'map'; readonly value: CborMapEntry[] }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' };

interface CborMapEntry {
  readonly key: CborValue;
  readonly value: CborValue;
}

interface ParsedSnapshotView {
  readonly jobId: string;
  readonly albumId: string;
  readonly createdAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly state: DownloadJobStateView;
  readonly photos: DownloadPhotoStateView[];
  readonly failureLog: DownloadFailureView[];
}

const PHASE_BY_CODE: Readonly<Record<number, DownloadPhase>> = {
  0: 'Idle',
  1: 'Preparing',
  2: 'Running',
  3: 'Paused',
  4: 'Finalizing',
  5: 'Done',
  6: 'Errored',
  7: 'Cancelled',
};

const PHASE_CODE_BY_PHASE: Readonly<Record<DownloadPhase, number>> = {
  Idle: 0,
  Preparing: 1,
  Running: 2,
  Paused: 3,
  Finalizing: 4,
  Done: 5,
  Errored: 6,
  Cancelled: 7,
};

const PHOTO_STATUS_BY_CODE: Readonly<Record<number, keyof DownloadPhotoCounts>> = {
  0: 'pending',
  1: 'inflight',
  2: 'done',
  3: 'failed',
  4: 'skipped',
};

const DOWNLOAD_ERROR_CODE_BY_REASON: Readonly<Record<DownloadErrorReason, number>> = {
  TransientNetwork: 0,
  Integrity: 1,
  Decrypt: 2,
  NotFound: 3,
  AccessRevoked: 4,
  AuthorizationChanged: 5,
  Quota: 6,
  Cancelled: 7,
  IllegalState: 8,
};

/** Singleton worker implementation hosting all Phase 1 download jobs. */
export class CoordinatorWorker implements CoordinatorWorkerApi {
  private initialized = false;
  private initializePromise: Promise<{ reconstructedJobs: number }> | null = null;
  private readonly jobs = new Map<string, InMemoryJob>();
  private readonly subscribers = new Map<string, Set<SubscriptionCallback>>();
  private readonly channel: BroadcastChannel | null;

  constructor() {
    this.channel = createBroadcastChannel();
    this.channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      this.handleBroadcastMessage(event.data);
    });
  }

  /** Initialize WASM and reconstruct persisted OPFS jobs. Idempotent. */
  initialize(_opts: { readonly nowMs: number }): Promise<{ reconstructedJobs: number }> {
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  /** Build a Rust download plan and create a new persisted job. */
  async startJob(input: StartJobInput): Promise<{ jobId: string }> {
    this.assertInitialized();
    const planInput: DownloadBuildPlanInput = { photos: input.photos };
    const { planBytes } = await rustBuildDownloadPlan(planInput);
    const jobIdBytes = randomJobIdBytes();
    const jobId = bytesToHex(jobIdBytes);
    const nowMs = Date.now();
    const initialized = await rustInitDownloadSnapshot({
      jobId: jobIdBytes,
      albumId: input.albumId,
      planBytes,
      nowMs,
    });

    await opfsStaging.createJobDir(jobId);
    await opfsStaging.writeSnapshot(jobId, initialized.bodyBytes, initialized.checksum);

    const idleState = extractStateValue(initialized.bodyBytes);
    const eventBytes = encodeStartRequestedEvent(jobIdBytes, input.albumId);
    const applied = await rustApplyDownloadEvent(encodeCbor(idleState), eventBytes);
    const updatedBody = patchSnapshotState(initialized.bodyBytes, applied.newStateBytes, Date.now());
    const committed = await rustCommitDownloadSnapshot(updatedBody);
    await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);

    const job = createInMemoryJob(updatedBody, committed.checksum);
    this.jobs.set(jobId, job);
    log.info('Job started', { jobId: shortId(jobId) });
    this.emitJobChanged(job);
    return { jobId };
  }

  /** Apply a Rust download event, persist the updated snapshot, and emit progress. */
  async sendEvent(jobId: string, event: DownloadEventInput): Promise<{ phase: DownloadPhase }> {
    this.assertInitialized();
    const job = this.requireJob(jobId);
    const currentState = extractStateValue(job.snapshotBytes);
    const applied = await rustApplyDownloadEvent(encodeCbor(currentState), encodeEvent(event));
    const updatedBody = patchSnapshotState(job.snapshotBytes, applied.newStateBytes, Date.now());
    const committed = await rustCommitDownloadSnapshot(updatedBody);
    await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);

    const updated = createInMemoryJob(updatedBody, committed.checksum);
    this.jobs.set(jobId, updated);
    if (event.kind === 'CancelRequested' && event.soft === false) {
      await opfsStaging.purgeJob(jobId);
      this.jobs.delete(jobId);
      this.emitProgress(summaryToProgress(updated));
      this.broadcast(updated);
      return { phase: updated.state.phase };
    }

    this.emitJobChanged(updated);
    return { phase: updated.state.phase };
  }

  /** Pause a running job. */
  pauseJob(jobId: string): Promise<{ phase: DownloadPhase }> {
    return this.sendEvent(jobId, { kind: 'PauseRequested' });
  }

  /** Resume a paused job. */
  resumeJob(jobId: string): Promise<{ phase: DownloadPhase }> {
    return this.sendEvent(jobId, { kind: 'ResumeRequested' });
  }

  /** Cancel a job; hard cancel also purges OPFS staging. */
  cancelJob(jobId: string, opts: { readonly soft: boolean }): Promise<{ phase: DownloadPhase }> {
    return this.sendEvent(jobId, { kind: 'CancelRequested', soft: opts.soft });
  }

  /** List all known in-memory + OPFS jobs. */
  async listJobs(): Promise<JobSummary[]> {
    this.assertInitialized();
    await this.reconcilePersistedJobs();
    return [...this.jobs.values()].map(toJobSummary).sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  /** Return an in-memory job summary without re-reading OPFS. */
  async getJob(jobId: string): Promise<JobSummary | null> {
    this.assertInitialized();
    const job = this.jobs.get(jobId);
    return job ? toJobSummary(job) : null;
  }

  /** Subscribe to progress events for one job. Caller must unsubscribe. */
  async subscribe(
    jobId: string,
    callback: SubscriptionCallback,
  ): Promise<{ unsubscribe: () => void }> {
    this.assertInitialized();
    let callbacks = this.subscribers.get(jobId);
    if (!callbacks) {
      callbacks = new Set<SubscriptionCallback>();
      this.subscribers.set(jobId, callbacks);
    }
    callbacks.add(callback);
    const job = this.jobs.get(jobId);
    if (job) {
      callback(summaryToProgress(job));
    }
    return {
      unsubscribe: Comlink.proxy((): void => {
        callbacks?.delete(callback);
        if (callbacks?.size === 0) {
          this.subscribers.delete(jobId);
        }
      }),
    };
  }

  /** Garbage-collect stale OPFS jobs. */
  async gc(opts: {
    readonly nowMs: number;
    readonly maxAgeMs: number;
    readonly preserveJobIds?: ReadonlyArray<string>;
  }): Promise<{ purged: string[] }> {
    this.assertInitialized();
    const preserve = new Set(opts.preserveJobIds ?? []);
    const result = await opfsStaging.gcStaleJobs({
      nowMs: opts.nowMs,
      maxAgeMs: opts.maxAgeMs,
      preserveJobIds: preserve,
    });
    for (const jobId of result.purged) {
      this.jobs.delete(jobId);
    }
    return { purged: result.purged };
  }

  private async initializeOnce(): Promise<{ reconstructedJobs: number }> {
    await ensureRustReady();
    const reconstructedJobs = await this.reconcilePersistedJobs();
    this.initialized = true;
    log.info('Coordinator initialized', { reconstructedJobs });
    return { reconstructedJobs };
  }

  private async reconcilePersistedJobs(): Promise<number> {
    const persistedJobs = await opfsStaging.listJobs();
    let reconstructedJobs = 0;
    for (const jobId of persistedJobs) {
      if (await this.reconstructPersistedJob(jobId)) {
        reconstructedJobs += 1;
      }
    }
    return reconstructedJobs;
  }

  private async reconstructPersistedJob(jobId: string): Promise<boolean> {
    if (this.jobs.has(jobId)) {
      return false;
    }
    try {
      const persisted = await opfsStaging.readSnapshot(jobId);
      if (!persisted || persisted.checksum.byteLength !== CHECKSUM_BYTES) {
        return false;
      }
      const verified = await rustVerifyDownloadSnapshot(persisted.body, persisted.checksum);
      if (!verified.valid) {
        log.warn('Skipping unverifiable download snapshot', { jobId: shortId(jobId) });
        return false;
      }
      const loaded = await rustLoadDownloadSnapshot(persisted.body, persisted.checksum);
      const job = createInMemoryJob(loaded.snapshotBytes, persisted.checksum);
      this.jobs.set(job.jobId, job);
      return true;
    } catch (error) {
      log.warn('Skipping corrupt download snapshot', {
        jobId: shortId(jobId),
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
      return false;
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.WorkerNotInitialized,
        'Coordinator worker initialize() must complete before use',
      );
    }
  }

  private requireJob(jobId: string): InMemoryJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.JobNotFound,
        'Download job not found',
      );
    }
    return job;
  }

  private emitJobChanged(job: InMemoryJob): void {
    this.emitProgress(summaryToProgress(job));
    this.broadcast(job);
  }

  private emitProgress(event: JobProgressEvent): void {
    const callbacks = this.subscribers.get(event.jobId);
    if (!callbacks) {
      return;
    }
    for (const callback of callbacks) {
      callback(event);
    }
  }

  private broadcast(job: InMemoryJob): void {
    const message: DownloadJobsBroadcastMessage = {
      kind: 'job-changed',
      jobId: job.jobId,
      phase: job.state.phase,
      lastUpdatedAtMs: job.lastUpdatedAtMs,
    };
    this.channel?.postMessage(message);
  }

  private handleBroadcastMessage(data: unknown): void {
    if (!isDownloadJobsBroadcastMessage(data)) {
      return;
    }
    void (async (): Promise<void> => {
      await this.reconstructPersistedJob(data.jobId);
      const localJob = this.jobs.get(data.jobId);
      if (localJob) {
        this.emitProgress(summaryToProgress(localJob));
      }
    })();
  }
}

function createBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME);
}

function isDownloadJobsBroadcastMessage(value: unknown): value is DownloadJobsBroadcastMessage {
  return typeof value === 'object'
    && value !== null
    && 'kind' in value
    && value.kind === 'job-changed'
    && 'jobId' in value
    && typeof value.jobId === 'string'
    && 'phase' in value
    && typeof value.phase === 'string'
    && 'lastUpdatedAtMs' in value
    && typeof value.lastUpdatedAtMs === 'number';
}

function createInMemoryJob(snapshotBytes: Uint8Array, checksum: Uint8Array): InMemoryJob {
  const view = parseSnapshotView(snapshotBytes);
  return {
    jobId: view.jobId,
    albumId: view.albumId,
    snapshotBytes,
    snapshotChecksum: checksum,
    state: view.state,
    photos: view.photos,
    failureLog: view.failureLog,
    createdAtMs: view.createdAtMs,
    lastUpdatedAtMs: view.lastUpdatedAtMs,
  };
}

function toJobSummary(job: InMemoryJob): JobSummary {
  return {
    jobId: job.jobId,
    albumId: job.albumId,
    phase: job.state.phase,
    photoCounts: countPhotos(job.photos),
    failureCount: job.failureLog.length,
    createdAtMs: job.createdAtMs,
    lastUpdatedAtMs: job.lastUpdatedAtMs,
  };
}

function summaryToProgress(job: InMemoryJob): JobProgressEvent {
  return {
    jobId: job.jobId,
    phase: job.state.phase,
    photoCounts: countPhotos(job.photos),
    failureCount: job.failureLog.length,
    lastUpdatedAtMs: job.lastUpdatedAtMs,
  };
}

function countPhotos(photos: readonly DownloadPhotoStateView[]): DownloadPhotoCounts {
  const counts = { pending: 0, inflight: 0, done: 0, failed: 0, skipped: 0 };
  for (const photo of photos) {
    counts[photo.status] += 1;
  }
  return counts;
}

function parseSnapshotView(bytes: Uint8Array): ParsedSnapshotView {
  const root = parseCbor(bytes);
  const fields = expectMap(root);
  const jobId = bytesToHex(expectBytes(requiredMapValue(fields, 1)));
  const albumBytes = expectBytes(requiredMapValue(fields, 2));
  return {
    jobId,
    albumId: uuidBytesToString(albumBytes),
    createdAtMs: expectUint(requiredMapValue(fields, 3)),
    lastUpdatedAtMs: expectUint(requiredMapValue(fields, 4)),
    state: parseState(requiredMapValue(fields, 5)),
    photos: expectArray(requiredMapValue(fields, 7)).map(parsePhoto),
    failureLog: expectArray(requiredMapValue(fields, 8)).map(parseFailure),
  };
}

function extractStateValue(snapshotBytes: Uint8Array): CborValue {
  return requiredMapValue(expectMap(parseCbor(snapshotBytes)), 5);
}

function patchSnapshotState(snapshotBytes: Uint8Array, newStateBytes: Uint8Array, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    if (key === 4) {
      return { key: entry.key, value: uintValue(nowMs) };
    }
    if (key === 5) {
      return { key: entry.key, value: parseCbor(newStateBytes) };
    }
    return entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function parseState(value: CborValue): DownloadJobStateView {
  const code = expectUint(requiredMapValue(expectMap(value), 0));
  const phase = PHASE_BY_CODE[code];
  if (!phase) {
    throw new Error('Unknown download phase code');
  }
  return { phase };
}

function parsePhoto(value: CborValue): DownloadPhotoStateView {
  const fields = expectMap(value);
  const statusFields = expectMap(requiredMapValue(fields, 1));
  const statusCode = expectUint(requiredMapValue(statusFields, 0));
  const status = PHOTO_STATUS_BY_CODE[statusCode];
  if (!status) {
    throw new Error('Unknown download photo status code');
  }
  return { status };
}

function parseFailure(value: CborValue): DownloadFailureView {
  const fields = expectMap(value);
  return { atMs: expectUint(requiredMapValue(fields, 2)) };
}

function encodeStartRequestedEvent(jobIdBytes: Uint8Array, albumId: string): Uint8Array {
  return encodeCbor({
    kind: 'map',
    value: [
      { key: uintValue(0), value: uintValue(0) },
      { key: uintValue(1), value: { kind: 'bytes', value: jobIdBytes } },
      { key: uintValue(2), value: { kind: 'text', value: albumId } },
    ],
  });
}

function encodeEvent(event: DownloadEventInput): Uint8Array {
  switch (event.kind) {
    case 'PlanReady':
      return encodeEventKind(1);
    case 'PauseRequested':
      return encodeEventKind(2);
    case 'ResumeRequested':
      return encodeEventKind(3);
    case 'CancelRequested':
      return encodeCbor({
        kind: 'map',
        value: [
          { key: uintValue(0), value: uintValue(4) },
          { key: uintValue(3), value: { kind: 'bool', value: event.soft } },
        ],
      });
    case 'ErrorEncountered':
      return encodeCbor({
        kind: 'map',
        value: [
          { key: uintValue(0), value: uintValue(5) },
          { key: uintValue(4), value: uintValue(DOWNLOAD_ERROR_CODE_BY_REASON[event.reason]) },
        ],
      });
    case 'AllPhotosDone':
      return encodeEventKind(6);
    case 'FinalizationDone':
      return encodeEventKind(7);
  }
}

function encodeEventKind(kind: number): Uint8Array {
  return encodeCbor({
    kind: 'map',
    value: [{ key: uintValue(0), value: uintValue(kind) }],
  });
}

function parseCbor(bytes: Uint8Array): CborValue {
  const parser = new CborParser(bytes);
  const value = parser.readValue();
  parser.assertDone();
  return value;
}

class CborParser {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readValue(): CborValue {
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0:
        return uintValue(this.readLength(additional));
      case 2:
        return { kind: 'bytes', value: this.readBytes(this.readLength(additional)) };
      case 3:
        return { kind: 'text', value: new TextDecoder().decode(this.readBytes(this.readLength(additional))) };
      case 4: {
        const length = this.readLength(additional);
        const items: CborValue[] = [];
        for (let index = 0; index < length; index += 1) {
          items.push(this.readValue());
        }
        return { kind: 'array', value: items };
      }
      case 5: {
        const length = this.readLength(additional);
        const entries: CborMapEntry[] = [];
        for (let index = 0; index < length; index += 1) {
          entries.push({ key: this.readValue(), value: this.readValue() });
        }
        return { kind: 'map', value: entries };
      }
      case 7:
        if (additional === 20 || additional === 21) {
          return { kind: 'bool', value: additional === 21 };
        }
        if (additional === 22) {
          return { kind: 'null' };
        }
        break;
    }
    throw new Error('Unsupported CBOR value');
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error('Trailing CBOR bytes');
    }
  }

  private readByte(): number {
    const byte = this.bytes[this.offset];
    if (byte === undefined) {
      throw new Error('Unexpected end of CBOR');
    }
    this.offset += 1;
    return byte;
  }

  private readLength(additional: number): number {
    if (additional < 24) {
      return additional;
    }
    if (additional === 24) {
      return this.readByte();
    }
    if (additional === 25) {
      return this.readUnsigned(2);
    }
    if (additional === 26) {
      return this.readUnsigned(4);
    }
    if (additional === 27) {
      return this.readUnsigned(8);
    }
    throw new Error('Unsupported CBOR length');
  }

  private readUnsigned(length: number): number {
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      value = value * 256 + this.readByte();
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error('CBOR integer exceeds safe range');
    }
    return value;
  }

  private readBytes(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new Error('Unexpected end of CBOR bytes');
    }
    const out = this.bytes.slice(this.offset, end);
    this.offset = end;
    return out;
  }
}

function encodeCbor(value: CborValue): Uint8Array {
  switch (value.kind) {
    case 'uint':
      return cborTypeAndLength(0, value.value);
    case 'bytes':
      return concatBytes([cborTypeAndLength(2, value.value.length), value.value]);
    case 'text': {
      const encoded = new TextEncoder().encode(value.value);
      return concatBytes([cborTypeAndLength(3, encoded.length), encoded]);
    }
    case 'array':
      return concatBytes([cborTypeAndLength(4, value.value.length), ...value.value.map(encodeCbor)]);
    case 'map': {
      const parts: Uint8Array[] = [cborTypeAndLength(5, value.value.length)];
      for (const entry of value.value) {
        parts.push(encodeCbor(entry.key), encodeCbor(entry.value));
      }
      return concatBytes(parts);
    }
    case 'bool':
      return new Uint8Array([value.value ? 0xf5 : 0xf4]);
    case 'null':
      return new Uint8Array([0xf6]);
  }
}

function cborTypeAndLength(major: number, length: number): Uint8Array {
  if (length < 24) {
    return new Uint8Array([(major << 5) | length]);
  }
  if (length <= 0xff) {
    return new Uint8Array([(major << 5) | 24, length]);
  }
  if (length <= 0xffff) {
    return new Uint8Array([(major << 5) | 25, length >> 8, length & 0xff]);
  }
  if (length <= 0xffffffff) {
    return new Uint8Array([
      (major << 5) | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ]);
  }
  if (Number.isSafeInteger(length) && length >= 0) {
    let remaining = BigInt(length);
    const bytes = new Uint8Array(9);
    bytes[0] = (major << 5) | 27;
    for (let index = 8; index >= 1; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return bytes;
  }
  throw new Error('CBOR length too large');
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function expectMap(value: CborValue): CborMapEntry[] {
  if (value.kind !== 'map') {
    throw new Error('Expected CBOR map');
  }
  return value.value;
}

function expectArray(value: CborValue): CborValue[] {
  if (value.kind !== 'array') {
    throw new Error('Expected CBOR array');
  }
  return value.value;
}

function expectBytes(value: CborValue): Uint8Array {
  if (value.kind !== 'bytes') {
    throw new Error('Expected CBOR bytes');
  }
  return value.value;
}

function expectUint(value: CborValue): number {
  if (value.kind !== 'uint') {
    throw new Error('Expected CBOR uint');
  }
  return value.value;
}

function requiredMapValue(entries: readonly CborMapEntry[], key: number): CborValue {
  const entry = entries.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  if (!entry) {
    throw new Error('Missing CBOR map key');
  }
  return entry.value;
}

function uintValue(value: number): CborValue {
  return { kind: 'uint', value };
}

function randomJobIdBytes(): Uint8Array {
  const bytes = new Uint8Array(JOB_ID_HEX_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function uuidBytesToString(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error('UUID byte length must be 16');
  }
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

const coordinatorWorker = new CoordinatorWorker();
Comlink.expose(coordinatorWorker);

export const __coordinatorWorkerTestUtils = {
  encodeCbor,
  parseCbor,
  uintValue,
  phaseCodeByPhase: PHASE_CODE_BY_PHASE,
};
