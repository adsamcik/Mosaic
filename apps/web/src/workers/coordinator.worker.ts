/// <reference lib="webworker" />
/**
 * Phase 2 caveat: a job's `DownloadOutputMode` is held in-memory ONLY on the
 * coordinator. It is intentionally NOT persisted into the Rust snapshot to
 * avoid a schema bump. If the worker restarts mid-job (tab reload, crash) the
 * resumed job defaults to `keepOffline` (staged bytes are preserved) and the
 * UI is expected to re-prompt the user via the mode picker. Persisting output
 * mode is tracked for Phase 3.
 */
import * as Comlink from 'comlink';
import { createLogger } from '../lib/logger';
import * as opfsStaging from '../lib/opfs-staging';
import { downloadShards } from '../lib/shard-service';
import { getOrFetchEpochKey } from '../lib/epoch-key-service';
import {
  ensureRustReady,
  rustApplyDownloadEvent,
  rustBuildDownloadPlan,
  rustCommitDownloadSnapshot,
  rustInitDownloadSnapshot,
  rustLoadDownloadSnapshot,
  rustVerifyDownloadSnapshot,
} from './rust-crypto-core';
import { getCryptoPool, type CryptoPool, type DownloadErrorCode } from './crypto-pool';
import { executePhotoTask, type DownloadPlanEntry, type PhotoOutcome } from './coordinator/photo-pipeline';
import { WorkerCryptoError, WorkerCryptoErrorCode } from './types';
import type {
  CoordinatorWorkerApi,
  DownloadBuildPlanInput,
  DownloadErrorReason,
  DownloadEventInput,
  DownloadFailureView,
  DownloadJobStateView,
  DownloadJobsBroadcastMessage,
  DownloadOutputMode,
  DownloadPhase,
  DownloadPhotoCounts,
  DownloadPhotoStateView,
  JobProgressEvent,
  JobSummary,
  RemoteByteSink,
  RemoteSaveTargetProvider,
  ResumableJobSummary,
  CurrentAlbumManifest,
  AlbumDiff,
  StartJobInput,
} from './types';
import { runZipFinalizer as defaultRunZipFinalizer, type ZipFinalizerDeps } from './coordinator/zip-finalizer';

const log = createLogger('CoordinatorWorker');
const CHANNEL_NAME = 'mosaic-download-jobs';
const JOB_ID_HEX_BYTES = 16;
const CHECKSUM_BYTES = 32;
const DEFAULT_BYTE_PROGRESS_RATE_LIMIT_MS = 2_000;

interface CoordinatorWorkerOptions {
  readonly byteProgressRateLimitMs?: number;
}

interface ByteProgressTimer {
  readonly jobId: string;
  lastWriteAtMs: number;
  pendingWrite: ReturnType<typeof setTimeout> | null;
}

let getCryptoPoolForCoordinator = getCryptoPool;
let executePhotoTaskForCoordinator = executePhotoTask;
let runZipFinalizerForCoordinator: typeof defaultRunZipFinalizer = defaultRunZipFinalizer;

interface InMemoryJob {
  readonly jobId: string;
  readonly albumId: string;
  snapshotBytes: Uint8Array;
  snapshotChecksum: Uint8Array;
  state: DownloadJobStateView;
  photos: DownloadPhotoStateView[];
  failureLog: DownloadFailureView[];
  readonly plan: DownloadPlanEntry[];
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
  readonly plan: DownloadPlanEntry[];
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
  private readonly jobMutations = new Map<string, Promise<void>>();
  private readonly jobAborts = new Map<string, AbortController>();
  private readonly jobDrivers = new Map<string, Promise<void>>();
  private readonly byteProgressTimers = new Map<string, ByteProgressTimer>();
  private readonly byteProgressRateLimitMs: number;
  private readonly channel: BroadcastChannel | null;
  /** Per-job output mode, kept in-memory only (Phase 2). See file header. */
  private readonly jobOutputModes = new Map<string, DownloadOutputMode>();
  /** Main-thread provider for opening writable byte sinks during finalize. */
  private saveTargetProvider: RemoteSaveTargetProvider | null = null;

  constructor(opts: CoordinatorWorkerOptions = {}) {
    this.byteProgressRateLimitMs = opts.byteProgressRateLimitMs ?? DEFAULT_BYTE_PROGRESS_RATE_LIMIT_MS;
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
    const outputMode: DownloadOutputMode = input.outputMode ?? { kind: 'keepOffline' };
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
    this.jobOutputModes.set(jobId, outputMode);
    log.info('Job started', { jobId: shortId(jobId), outputMode: outputMode.kind });
    this.emitJobChanged(job);
    await this.sendEvent(jobId, { kind: 'PlanReady' });
    this.scheduleJobDriver(jobId);
    return { jobId };
  }

  /** Apply a Rust download event, persist the updated snapshot, and emit progress. */
  async sendEvent(jobId: string, event: DownloadEventInput): Promise<{ phase: DownloadPhase }> {
    this.assertInitialized();
    await this.flushByteProgress(jobId);
    return this.withJobLock(jobId, () => this.sendEventLocked(jobId, event));
  }

  private async sendEventLocked(jobId: string, event: DownloadEventInput): Promise<{ phase: DownloadPhase }> {
    const job = this.requireJob(jobId);
    if (isIdempotentEvent(job.state.phase, event)) {
      this.emitJobChanged(job);
      return { phase: job.state.phase };
    }
    const currentState = extractStateValue(job.snapshotBytes);
    const applied = await rustApplyDownloadEvent(encodeCbor(currentState), encodeEvent(event));
    const updatedBody = patchSnapshotState(job.snapshotBytes, applied.newStateBytes, Date.now());
    const committed = await rustCommitDownloadSnapshot(updatedBody);
    await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);

    const updated = createInMemoryJob(updatedBody, committed.checksum);
    this.jobs.set(jobId, updated);
    this.markByteProgressPersisted(jobId);
    if (event.kind === 'PauseRequested' || event.kind === 'CancelRequested') {
      this.jobAborts.get(jobId)?.abort();
    }
    if (updated.state.phase === 'Running' && (event.kind === 'PlanReady' || event.kind === 'ResumeRequested')) {
      this.scheduleJobDriver(jobId);
    }

    if (event.kind === 'CancelRequested' && event.soft === false) {
      await opfsStaging.purgeJob(jobId);
      this.jobs.delete(jobId);
      this.jobOutputModes.delete(jobId);
      this.emitProgress(summaryToProgress(updated));
      this.broadcast(updated);
      return { phase: updated.state.phase };
    }

    this.emitJobChanged(updated);
    return { phase: updated.state.phase };
  }

  /** Pause a running job. */
  pauseJob(jobId: string): Promise<{ phase: DownloadPhase }> {
    this.jobAborts.get(jobId)?.abort();
    return this.sendEvent(jobId, { kind: 'PauseRequested' });
  }

  /** Resume a paused job. */
  resumeJob(jobId: string): Promise<{ phase: DownloadPhase }> {
    return this.sendEvent(jobId, { kind: 'ResumeRequested' });
  }

  /** Cancel a job; hard cancel also purges OPFS staging. */
  cancelJob(jobId: string, opts: { readonly soft: boolean }): Promise<{ phase: DownloadPhase }> {
    this.jobAborts.get(jobId)?.abort();
    return this.sendEvent(jobId, { kind: 'CancelRequested', soft: opts.soft });
  }

  /** List all known in-memory + OPFS jobs. */
  async listJobs(): Promise<JobSummary[]> {
    this.assertInitialized();
    await this.reconcilePersistedJobs();
    return [...this.jobs.values()].map(toJobSummary).sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  /** List non-terminal jobs with useful completed work for resuming. */
  async listResumableJobs(): Promise<ResumableJobSummary[]> {
    this.assertInitialized();
    await this.reconcilePersistedJobs();
    return [...this.jobs.values()]
      .filter(isResumableJob)
      .map(toResumableJobSummary)
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  /** Compute a local album diff from the persisted plan and current manifest. */
  async computeAlbumDiff(jobId: string, current: CurrentAlbumManifest): Promise<AlbumDiff> {
    this.assertInitialized();
    let job = this.jobs.get(jobId);
    if (!job) {
      job = await this.refreshPersistedJob(jobId);
    }
    if (!job) {
      job = this.requireJob(jobId);
    }
    return computeAlbumDiffFromPlan(job.plan, current);
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
      this.jobOutputModes.delete(jobId);
    }
    return { purged: result.purged };
  }

  /** Register or clear the main-thread save-target factory. See {@link CoordinatorWorkerApi}. */
  setSaveTargetProvider(provider: RemoteSaveTargetProvider | null): Promise<void> {
    this.saveTargetProvider = provider;
    return Promise.resolve();
  }

  /** Dispatch to the appropriate finalizer for this job's output mode. */
  private async runFinalizer(jobId: string, mode: DownloadOutputMode, signal: AbortSignal): Promise<void> {
    switch (mode.kind) {
      case 'keepOffline':
        return;
      case 'zip':
        await this.runZipFinalizer(jobId, mode.fileName, signal);
        return;
      default: {
        const _exhaustive: never = mode;
        throw new Error(`Unknown output mode: ${String(_exhaustive)}`);
      }
    }
  }

  private async runZipFinalizer(jobId: string, fileName: string, signal: AbortSignal): Promise<void> {
    const provider = this.saveTargetProvider;
    if (!provider) {
      throw new Error('No save-target provider registered for ZIP finalizer');
    }
    const job = this.requireJob(jobId);
    const entries = job.plan.map((entry) => ({ photoId: entry.photoId, filename: entry.filename }));
    const deps: ZipFinalizerDeps = {
      readPhotoStream: opfsStaging.readPhotoStream,
      getPhotoFileLength: opfsStaging.getPhotoFileLength,
      openSaveTarget: async (name: string): Promise<WritableStream<Uint8Array>> => {
        const sink = await provider(name);
        return sinkToWritableStream(sink);
      },
    };
    await runZipFinalizerForCoordinator({ jobId, entries }, fileName, deps, signal);
  }

  private scheduleJobDriver(jobId: string): void {
    if (this.jobDrivers.has(jobId)) {
      return;
    }
    const driver = this.runJobDriver(jobId)
      .catch((error: unknown) => {
        log.warn('Download driver stopped unexpectedly', {
          jobId: shortId(jobId),
          errorName: error instanceof Error ? error.name : 'Unknown',
        });
      })
      .finally(() => {
        if (this.jobDrivers.get(jobId) === driver) {
          this.jobDrivers.delete(jobId);
        }
      });
    this.jobDrivers.set(jobId, driver);
  }

  async runJobDriver(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state.phase !== 'Running') {
      return;
    }
    const pool = await getCryptoPoolForCoordinator();
    const abortController = new AbortController();
    this.jobAborts.set(jobId, abortController);
    try {
      const pendingPhotos = job.photos.filter((photo) => photo.status === 'pending' || photo.status === 'inflight');
      await runWithConcurrency(pendingPhotos, pool.size, async (photo) => {
        if (abortController.signal.aborted || this.jobs.get(jobId)?.state.phase !== 'Running') {
          return;
        }
        const entry = this.jobs.get(jobId)?.plan.find((candidate) => candidate.photoId === photo.photoId);
        if (!entry) {
          await this.sendEvent(jobId, { kind: 'ErrorEncountered', reason: 'IllegalState' });
          abortController.abort();
          return;
        }
        await this.transitionPhoto(jobId, photo.photoId, { kind: 'inflight' });
        const outcome = await executePhotoTaskForCoordinator({
          jobId,
          albumId: job.albumId,
          entry,
          resumeFromBytes: photo.bytesWritten,
          signal: abortController.signal,
        }, this.pipelineDeps(pool));
        await this.handlePhotoOutcome(jobId, photo.photoId, outcome);
      });

      const latest = this.jobs.get(jobId);
      if (!abortController.signal.aborted && latest?.state.phase === 'Running') {
        await this.sendEvent(jobId, { kind: 'AllPhotosDone' });
        try {
          const mode = this.jobOutputModes.get(jobId) ?? { kind: 'keepOffline' };
          await this.runFinalizer(jobId, mode, abortController.signal);
          await this.sendEvent(jobId, { kind: 'FinalizationDone' });
        } catch (err) {
          log.warn('Finalizer failed', { jobId: shortId(jobId), errorName: err instanceof Error ? err.name : 'Unknown' });
          await this.sendEvent(jobId, { kind: 'ErrorEncountered', reason: 'IllegalState' });
        }
      }
    } finally {
      if (this.jobAborts.get(jobId) === abortController) {
        this.jobAborts.delete(jobId);
      }
    }
  }

  private pipelineDeps(pool: CryptoPool): Parameters<typeof executePhotoTask>[1] {
    return {
      pool,
      fetchShards: async (shardIds: string[], signal: AbortSignal): Promise<Uint8Array[]> => {
        if (signal.aborted) {
          throw new DOMException('Download aborted', 'AbortError');
        }
        const shards = await downloadShards(shardIds, undefined, 4);
        if (signal.aborted) {
          throw new DOMException('Download aborted', 'AbortError');
        }
        return shards;
      },
      getEpochSeed: async (albumId: string, epochId: number): Promise<Uint8Array> => (await getOrFetchEpochKey(albumId, epochId)).epochSeed,
      writePhotoChunk: opfsStaging.writePhotoChunk,
      truncatePhoto: opfsStaging.truncatePhotoTo,
      getPhotoFileLength: opfsStaging.getPhotoFileLength,
      reportBytesWritten: (jobId: string, photoId: string, bytesWritten: number): void => {
        this.handleBytesWritten(jobId, photoId, bytesWritten);
      },
    };
  }

  private async handlePhotoOutcome(jobId: string, photoId: string, outcome: PhotoOutcome): Promise<void> {
    if (outcome.kind === 'done') {
      await this.transitionPhoto(jobId, photoId, { kind: 'done', bytesWritten: outcome.bytesWritten });
      return;
    }
    if (outcome.kind === 'skipped') {
      await this.transitionPhoto(jobId, photoId, { kind: 'skipped', reason: outcome.reason });
      return;
    }
    if (outcome.code === 'Cancelled') {
      await this.transitionPhoto(jobId, photoId, { kind: 'pending' });
      return;
    }
    await this.transitionPhoto(jobId, photoId, { kind: 'failed', reason: outcome.code });
    if (outcome.code === 'AccessRevoked' || outcome.code === 'AuthorizationChanged' || outcome.code === 'Quota') {
      this.jobAborts.get(jobId)?.abort();
      await this.sendEvent(jobId, { kind: 'ErrorEncountered', reason: outcome.code });
    }
  }

  private transitionPhoto(jobId: string, photoId: string, status: PhotoStatusPatch): Promise<void> {
    return this.withJobLock(jobId, async () => {
      const job = this.requireJob(jobId);
      if (job.state.phase !== 'Running' && status.kind !== 'pending') {
        return;
      }
      const updatedBody = patchSnapshotPhoto(job.snapshotBytes, photoId, status, Date.now());
      const committed = await rustCommitDownloadSnapshot(updatedBody);
      await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);
      const updated = createInMemoryJob(updatedBody, committed.checksum);
      this.jobs.set(jobId, updated);
      this.markByteProgressPersisted(jobId);
      this.emitJobChanged(updated);
    });
  }

  private handleBytesWritten(jobId: string, photoId: string, bytesWritten: number): void {
    const job = this.jobs.get(jobId);
    if (!job || bytesWritten < 0 || !Number.isFinite(bytesWritten)) {
      return;
    }
    const photo = job.photos.find((candidate) => candidate.photoId === photoId);
    if (!photo || photo.status === 'done' || photo.status === 'failed' || photo.status === 'skipped') {
      return;
    }
    const normalizedBytesWritten = Math.floor(bytesWritten);
    if (normalizedBytesWritten === photo.bytesWritten) {
      return;
    }
    const updatedBody = patchSnapshotPhotoBytes(job.snapshotBytes, photoId, normalizedBytesWritten, job.lastUpdatedAtMs);
    this.jobs.set(jobId, createInMemoryJob(updatedBody, job.snapshotChecksum));

    const nowMs = Date.now();
    const timer = this.byteProgressTimers.get(jobId) ?? { jobId, lastWriteAtMs: 0, pendingWrite: null };
    const delayMs = timer.lastWriteAtMs === 0 || nowMs - timer.lastWriteAtMs >= this.byteProgressRateLimitMs
      ? 0
      : Math.max(0, timer.lastWriteAtMs + this.byteProgressRateLimitMs - nowMs);
    if (timer.pendingWrite) {
      clearTimeout(timer.pendingWrite);
    }
    timer.pendingWrite = setTimeout(() => {
      timer.pendingWrite = null;
      void this.flushByteProgress(jobId).catch((error: unknown) => {
        log.warn('Byte-progress snapshot flush failed', {
          jobId: shortId(jobId),
          errorName: error instanceof Error ? error.name : 'Unknown',
        });
      });
    }, delayMs);
    this.byteProgressTimers.set(jobId, timer);
  }

  private async flushByteProgress(jobId: string): Promise<void> {
    const timer = this.byteProgressTimers.get(jobId);
    if (!timer) {
      return;
    }
    if (timer.pendingWrite) {
      clearTimeout(timer.pendingWrite);
      timer.pendingWrite = null;
    }
    await this.withJobLock(jobId, async () => {
      const job = this.jobs.get(jobId);
      if (!job) {
        this.byteProgressTimers.delete(jobId);
        return;
      }
      const nowMs = Date.now();
      const updatedBody = patchSnapshotLastUpdatedAtMs(job.snapshotBytes, nowMs);
      const committed = await rustCommitDownloadSnapshot(updatedBody);
      await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);
      const updated = createInMemoryJob(updatedBody, committed.checksum);
      this.jobs.set(jobId, updated);
      timer.lastWriteAtMs = nowMs;
      this.byteProgressTimers.set(jobId, timer);
      this.emitJobChanged(updated);
    });
  }

  private markByteProgressPersisted(jobId: string): void {
    const timer = this.byteProgressTimers.get(jobId);
    if (!timer) {
      return;
    }
    if (timer.pendingWrite) {
      clearTimeout(timer.pendingWrite);
      timer.pendingWrite = null;
    }
    timer.lastWriteAtMs = Date.now();
    this.byteProgressTimers.set(jobId, timer);
  }

  private async initializeOnce(): Promise<{ reconstructedJobs: number }> {
    await ensureRustReady();
    const reconstructedJobs = await this.reconcilePersistedJobs();
    this.initialized = true;
    for (const job of this.jobs.values()) {
      if (job.state.phase === 'Running') {
        this.scheduleJobDriver(job.jobId);
      }
    }
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
    return (await this.refreshPersistedJob(jobId)) !== null;
  }

  private async refreshPersistedJob(jobId: string): Promise<InMemoryJob | null> {
    try {
      const persisted = await opfsStaging.readSnapshot(jobId);
      if (!persisted || persisted.checksum.byteLength !== CHECKSUM_BYTES) {
        return null;
      }
      const verified = await rustVerifyDownloadSnapshot(persisted.body, persisted.checksum);
      if (!verified.valid) {
        log.warn('Skipping unverifiable download snapshot', { jobId: shortId(jobId) });
        return null;
      }
      const loaded = await rustLoadDownloadSnapshot(persisted.body, persisted.checksum);
      const job = createInMemoryJob(loaded.snapshotBytes, persisted.checksum);
      this.jobs.set(job.jobId, job);
      return job;
    } catch (error) {
      log.warn('Skipping corrupt download snapshot', {
        jobId: shortId(jobId),
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
      return null;
    }
  }

  private async withJobLock<T>(jobId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.jobMutations.get(jobId) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.jobMutations.set(jobId, chained);

    try {
      await previous;
      return await op();
    } finally {
      release();
      if (this.jobMutations.get(jobId) === chained) {
        this.jobMutations.delete(jobId);
      }
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
      const localJob = await this.refreshPersistedJob(data.jobId);
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

function isIdempotentEvent(phase: DownloadPhase, event: DownloadEventInput): boolean {
  return (event.kind === 'PlanReady' && phase === 'Running')
    || (event.kind === 'PauseRequested' && phase === 'Paused')
    || (event.kind === 'ResumeRequested' && phase === 'Running')
    || (event.kind === 'CancelRequested' && event.soft === true && phase === 'Cancelled');
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

type PhotoStatusPatch =
  | { readonly kind: 'pending' }
  | { readonly kind: 'inflight' }
  | { readonly kind: 'done'; readonly bytesWritten: number }
  | { readonly kind: 'failed'; readonly reason: DownloadErrorCode }
  | { readonly kind: 'skipped'; readonly reason: 'NotFound' | 'UserExcluded' };

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
    plan: view.plan,
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

function toResumableJobSummary(job: InMemoryJob): ResumableJobSummary {
  const summary = toJobSummary(job);
  return {
    ...summary,
    photosDone: summary.photoCounts.done,
    photosTotal: job.photos.length,
    bytesWritten: job.photos.reduce((total, photo) => total + photo.bytesWritten, 0),
    lastUpdatedAtMs: job.lastUpdatedAtMs,
  };
}

function isResumableJob(job: InMemoryJob): boolean {
  return (job.state.phase === 'Preparing' || job.state.phase === 'Running' || job.state.phase === 'Paused')
    && job.photos.some((photo) => photo.status === 'done');
}

function computeAlbumDiffFromPlan(plan: readonly DownloadPlanEntry[], current: CurrentAlbumManifest): AlbumDiff {
  const plannedByPhotoId = new Map(plan.map((entry) => [entry.photoId, entry]));
  const currentByPhotoId = new Map(current.photos.map((photo) => [photo.photoId, photo]));
  const removed: string[] = [];
  const added: string[] = [];
  const rekeyed: string[] = [];
  const unchanged: string[] = [];
  const shardChanged: string[] = [];

  for (const entry of plan) {
    if (!currentByPhotoId.has(entry.photoId)) {
      removed.push(entry.photoId);
    }
  }

  for (const photo of current.photos) {
    const planned = plannedByPhotoId.get(photo.photoId);
    if (!planned) {
      added.push(photo.photoId);
      continue;
    }
    if (planned.epochId !== photo.epochId) {
      rekeyed.push(photo.photoId);
      continue;
    }
    if (sameStringSet(planned.shardIds, photo.tier3ShardIds)) {
      unchanged.push(photo.photoId);
    } else {
      shardChanged.push(photo.photoId);
    }
  }

  return { removed, added, rekeyed, unchanged, shardChanged };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
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
    plan: expectArray(requiredMapValue(fields, 6)).map(parsePlanEntry),
    photos: expectArray(requiredMapValue(fields, 7)).map(parsePhoto),
    failureLog: expectArray(requiredMapValue(fields, 8)).map(parseFailure),
  };
}

function extractStateValue(snapshotBytes: Uint8Array): CborValue {
  return requiredMapValue(expectMap(parseCbor(snapshotBytes)), 5);
}

function patchSnapshotLastUpdatedAtMs(snapshotBytes: Uint8Array, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    return key === 4 ? { key: entry.key, value: uintValue(nowMs) } : entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function patchSnapshotPhotoBytes(snapshotBytes: Uint8Array, photoId: string, bytesWritten: number, lastUpdatedAtMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    if (key === 4) {
      return { key: entry.key, value: uintValue(lastUpdatedAtMs) };
    }
    if (key === 7) {
      const photos = expectArray(entry.value).map((photoValue) => patchPhotoBytesValue(photoValue, photoId, bytesWritten));
      return { key: entry.key, value: { kind: 'array', value: photos } as CborValue };
    }
    return entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function patchPhotoBytesValue(value: CborValue, photoId: string, bytesWritten: number): CborValue {
  const fields = expectMap(value);
  if (expectText(requiredMapValue(fields, 0)) !== photoId) {
    return value;
  }
  return {
    kind: 'map',
    value: fields.map((entry) => {
      const key = expectUint(entry.key);
      return key === 2 ? { key: entry.key, value: uintValue(bytesWritten) } : entry;
    }),
  };
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

function parsePlanEntry(value: CborValue): DownloadPlanEntry {
  const fields = expectMap(value);
  return {
    photoId: expectText(requiredMapValue(fields, 0)),
    epochId: expectUint(requiredMapValue(fields, 1)),
    tier: expectUint(requiredMapValue(fields, 2)),
    shardIds: expectArray(requiredMapValue(fields, 3)).map((item) => bytesToHex(expectBytes(item))),
    expectedHashes: expectArray(requiredMapValue(fields, 4)).map(expectBytes),
    filename: expectText(requiredMapValue(fields, 5)),
    totalBytes: expectUint(requiredMapValue(fields, 6)),
  };
}

function parsePhoto(value: CborValue): DownloadPhotoStateView {
  const fields = expectMap(value);
  const statusFields = expectMap(requiredMapValue(fields, 1));
  const statusCode = expectUint(requiredMapValue(statusFields, 0));
  const status = PHOTO_STATUS_BY_CODE[statusCode];
  if (!status) {
    throw new Error('Unknown download photo status code');
  }
  return {
    photoId: expectText(requiredMapValue(fields, 0)),
    status,
    bytesWritten: expectUint(requiredMapValue(fields, 2)),
    retryCount: expectUint(requiredMapValue(fields, 4)),
  };
}

function parseFailure(value: CborValue): DownloadFailureView {
  const fields = expectMap(value);
  return { atMs: expectUint(requiredMapValue(fields, 2)) };
}


function patchSnapshotPhoto(snapshotBytes: Uint8Array, photoId: string, patch: PhotoStatusPatch, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    if (key === 4) {
      return { key: entry.key, value: uintValue(nowMs) };
    }
    if (key === 7) {
      const photos = expectArray(entry.value).map((photoValue) => patchPhotoValue(photoValue, photoId, patch, nowMs));
      return { key: entry.key, value: { kind: 'array', value: photos } as CborValue };
    }
    if (key === 8 && (patch.kind === 'failed' || (patch.kind === 'skipped' && patch.reason === 'NotFound'))) {
      const reason: DownloadErrorCode = patch.kind === 'failed' ? patch.reason : 'NotFound';
      return {
        key: entry.key,
        value: {
          kind: 'array',
          value: [
            ...expectArray(entry.value),
            {
              kind: 'map',
              value: [
                { key: uintValue(0), value: { kind: 'text', value: photoId } },
                { key: uintValue(1), value: uintValue(DOWNLOAD_ERROR_CODE_BY_REASON[reason]) },
                { key: uintValue(2), value: uintValue(nowMs) },
              ],
            },
          ],
        } as CborValue,
      };
    }
    return entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function patchPhotoValue(value: CborValue, photoId: string, patch: PhotoStatusPatch, nowMs: number): CborValue {
  const fields = expectMap(value);
  if (expectText(requiredMapValue(fields, 0)) !== photoId) {
    return value;
  }
  return {
    kind: 'map',
    value: fields.map((entry) => {
      const key = expectUint(entry.key);
      if (key === 1) {
        return { key: entry.key, value: photoStatusValue(patch) };
      }
      if (key === 2) {
        return { key: entry.key, value: uintValue(patch.kind === 'done' ? patch.bytesWritten : expectUint(entry.value)) };
      }
      if (key === 3 && patch.kind === 'inflight') {
        return { key: entry.key, value: uintValue(nowMs) };
      }
      return entry;
    }),
  };
}

function photoStatusValue(patch: PhotoStatusPatch): CborValue {
  switch (patch.kind) {
    case 'pending':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(0) }] };
    case 'inflight':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(1) }] };
    case 'done':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(2) }] };
    case 'failed':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(3) }, { key: uintValue(1), value: uintValue(DOWNLOAD_ERROR_CODE_BY_REASON[patch.reason]) }] };
    case 'skipped':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(4) }, { key: uintValue(2), value: uintValue(patch.reason === 'NotFound' ? 0 : 1) }] };
  }
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

function expectText(value: CborValue): string {
  if (value.kind !== 'text') {
    throw new Error('Expected CBOR text');
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


async function runWithConcurrency<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const promise = worker(item).finally(() => {
      executing.delete(promise);
    });
    executing.add(promise);
    if (executing.size >= Math.max(1, concurrency)) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
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

function sinkToWritableStream(sink: RemoteByteSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk: Uint8Array): Promise<void> {
      await sink.write(chunk);
    },
    async close(): Promise<void> {
      await sink.close();
    },
    async abort(reason: unknown): Promise<void> {
      const message = typeof reason === 'string'
        ? reason
        : reason instanceof Error ? reason.message : 'aborted';
      await sink.abort(message);
    },
  });
}

export const __coordinatorWorkerTestUtils = {
  encodeCbor,
  parseCbor,
  uintValue,
  phaseCodeByPhase: PHASE_CODE_BY_PHASE,
  setCryptoPoolFactory(factory: typeof getCryptoPool): void {
    getCryptoPoolForCoordinator = factory;
  },
  setExecutePhotoTask(fn: typeof executePhotoTask): void {
    executePhotoTaskForCoordinator = fn;
  },
  setRunZipFinalizer(fn: typeof defaultRunZipFinalizer): void {
    runZipFinalizerForCoordinator = fn;
  },
  runJobDriver(worker: CoordinatorWorker, jobId: string): Promise<void> {
    return worker.runJobDriver(jobId);
  },
  awaitScheduledDriver(worker: CoordinatorWorker, jobId: string): Promise<void> {
    interface DriverMapHolder { readonly jobDrivers: Map<string, Promise<void>> }
    const map = (worker as unknown as DriverMapHolder).jobDrivers;
    return map.get(jobId) ?? Promise.resolve();
  },
};






