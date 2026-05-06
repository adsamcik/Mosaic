/// <reference lib="webworker" />
/**
 * Phase 2 caveat: a job's `DownloadOutputMode` is held in-memory ONLY on the
 * coordinator. It is intentionally NOT persisted into the Rust snapshot to
 * avoid a schema bump. If the worker restarts mid-job (tab reload, crash):
 *   - `initializeOnce` does NOT auto-spin drivers for reconstructed jobs.
 *   - The reconstructed jobs surface via `listResumableJobs()`.
 *   - The UI must call `resumeJob(jobId, { mode })` to re-register the user's
 *     chosen output mode before the driver / finalizer is started.
 * Persisting output mode in the snapshot is tracked for Phase 3.
 *
 * SourceStrategy is also held in-memory only on the coordinator and is NOT
 * persisted into the Rust snapshot. Reconstructed jobs default to the
 * authenticated source on resume; a future Phase 3 schema bump can persist
 * the strategy keying for visitor / share-link sessions if needed.
 */
import type { DownloadSchedule, ScheduleContext, ScheduleEvaluation } from '../lib/download-schedule';
import { captureScheduleContext } from '../lib/schedule-context';
import { ScheduleManager, type ScheduleManagerDeps } from './coordinator/schedule-manager';
import * as Comlink from 'comlink';
import { createLogger } from '../lib/logger';
import * as opfsStaging from '../lib/opfs-staging';
import { createAuthenticatedSourceStrategy } from './coordinator/source-strategy-auth';
import {
  isVisitorScopeKey,
  selectStaleVisitorJobs,
  VISITOR_GC_TTL_MS,
  VISITOR_RESUME_GRACE_MS,
} from './coordinator/visitor-gc';
import { ensureScopeKeySodiumReady, scopeKeyPrefix } from '../lib/scope-key';
import type { SourceStrategy } from './coordinator/source-strategy';
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
  PerFileStrategy,
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
import { runPerFileFinalizer as defaultRunPerFileFinalizer, type PerFileFinalizerDeps } from './coordinator/per-file-finalizer';
import { createShardMirror, type ShardMirror, type ShardMirrorStats } from './coordinator/shard-mirror';
import { createDecryptCache, type DecryptCache } from './coordinator/decrypt-cache';
import { createThumbnailStreamer, type ThumbnailManifestEntry, type ThumbnailStreamer } from './coordinator/thumbnail-streamer';


const log = createLogger('CoordinatorWorker');
const CHANNEL_NAME = 'mosaic-download-jobs';
const JOB_ID_HEX_BYTES = 16;
const CHECKSUM_BYTES = 32;
const DEFAULT_BYTE_PROGRESS_RATE_LIMIT_MS = 2_000;

interface CoordinatorWorkerOptions {
  readonly byteProgressRateLimitMs?: number;
  /**
   * Stable, non-secret account identifier used to derive the authenticated
   * tray scope key. When omitted the default-auth scope falls back to an
   * empty-input derivation; production callers MUST set this so jobs are
   * partitioned per identity.
   */
  readonly accountId?: string;
}

interface ByteProgressTimer {
  readonly jobId: string;
  lastWriteAtMs: number;
  pendingWrite: ReturnType<typeof setTimeout> | null;
}

let getCryptoPoolForCoordinator = getCryptoPool;
let executePhotoTaskForCoordinator = executePhotoTask;
let runZipFinalizerForCoordinator: typeof defaultRunZipFinalizer = defaultRunZipFinalizer;
let runPerFileFinalizerForCoordinator: typeof defaultRunPerFileFinalizer = defaultRunPerFileFinalizer;

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
  /** Tray scope key (`auth:|visitor:|legacy:` + 32-hex). ZK-safe to log only the prefix. */
  readonly scopeKey: string;
  /** Most-recent error reason from the persisted failure log, when any. */
  readonly lastErrorReason: DownloadErrorReason | null;
  /** Optional v3 schedule decoded from snapshot key 11. Null = Immediate. */
  schedule: DownloadSchedule | null;
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
  /** Tray scope key (CBOR snapshot key 10). v1 snapshots get a synthesized legacy fallback. */
  readonly scopeKey: string;
  /** Last failure reason persisted in the failure log (null when empty). */
  readonly lastErrorReason: DownloadErrorReason | null;
  /** Optional v3 schedule (CBOR snapshot key 11). Null when absent / Immediate. */
  readonly schedule: DownloadSchedule | null;
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

const DOWNLOAD_REASON_BY_CODE: Readonly<Record<number, DownloadErrorReason>> = (() => {
  const out: Record<number, DownloadErrorReason> = {} as Record<number, DownloadErrorReason>;
  for (const [reason, code] of Object.entries(DOWNLOAD_ERROR_CODE_BY_REASON)) {
    out[code] = reason as DownloadErrorReason;
  }
  return out;
})();


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
  /**
   * Per-job source strategy (in-memory only). Reconstructed jobs fall back
   * to {@link getDefaultAuthSource}. See file header.
   */
  private readonly jobSources = new Map<string, SourceStrategy>();
  /** Lazy-built default authenticated source (created on first use). */
  private defaultAuthSource: SourceStrategy | null = null;
  /** Account id used to derive the default-auth tray scope key. */
  private readonly accountId: string;
  /**
   * Per-job, per-photo export-side failure reasons (Phase 2 in-memory only).
   * Tracks per-file finalizer write failures WITHOUT mutating the source-side
   * photo status (which tracks staging, not export). Cleared on worker
   * restart; partially mitigated by the resume-prompt re-confirmation.
   */
  private readonly jobExportFailures = new Map<string, Map<string, DownloadErrorReason>>();
  /**
   * Visitor-scope job ids whose in-memory `SourceStrategy` was lost on
   * worker restart. Until the user re-opens the matching share link and
   * `rebindJobSource` is called, these jobs surface in the resume prompt
   * as `pausedNoSource: true` and `resumeJob` rejects with IllegalState.
   * Auth and legacy jobs are NEVER added — they keep their existing resume
   * path via the default authenticated source.
   */
  private readonly pausedNoSourceVisitorJobs = new Set<string>();
  /** Main-thread provider for opening writable byte sinks during finalize. */
  private saveTargetProvider: RemoteSaveTargetProvider | null = null;
  /** Ambient encrypted-shard mirror (OPFS-backed) shared across all jobs. */
  private readonly shardMirror: ShardMirror = createShardMirror();
  /** In-memory LRU of derived epoch keys; zeroed on clear/eviction. */
  private readonly decryptCache: DecryptCache = createDecryptCache();
  /**
   * Per-job most-recent {@link ScheduleEvaluation} snapshot, kept in-memory
   * only. Drives the `JobSummary.scheduleEvaluation` field exposed to the
   * tray. ZK-safe: evaluation `reason` strings are generic and ID-free.
   */
  private readonly lastEvaluations = new Map<string, ScheduleEvaluation>();
  /** Wallclock when each scheduled job was registered (manager input). */
  private readonly scheduledAt = new Map<string, number>();
  /** Lazy-built schedule manager. */
  private scheduleManagerInstance: ScheduleManager | null = null;
  /**
   * Per-job thumbnail manifests, kept in-memory ONLY. Thumbnails are an
   * in-app preview and are never persisted or exported (see streamer header).
   */
  private readonly jobThumbnailManifests = new Map<string, ReadonlyArray<{ readonly photoId: string; readonly epochId: string; readonly thumbShardId: string }>>();
  /** Singleton thumbnail streamer; lazy-built on first subscription. */
  private thumbnailStreamerInstance: ThumbnailStreamer | null = null;

  constructor(opts: CoordinatorWorkerOptions = {}) {
    this.byteProgressRateLimitMs = opts.byteProgressRateLimitMs ?? DEFAULT_BYTE_PROGRESS_RATE_LIMIT_MS;
    this.accountId = opts.accountId ?? '';
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
    const schedule = input.schedule ?? null;
    const isScheduled = schedule !== null && schedule.kind !== 'immediate';
    const planInput: DownloadBuildPlanInput = { photos: input.photos };
    const { planBytes } = await rustBuildDownloadPlan(planInput);
    const jobIdBytes = randomJobIdBytes();
    const jobId = bytesToHex(jobIdBytes);
    const nowMs = Date.now();
    // Resolve the tray scope key from the per-job source (when supplied) or
    // from the default authenticated source. Persisted in the v2 snapshot so
    // the tray can filter jobs by identity across worker restarts.
    const sourceForScope = input.source ?? this.getDefaultAuthSource();
    const scopeKey = sourceForScope.getScopeKey();
    const initialized = await rustInitDownloadSnapshot({
      jobId: jobIdBytes,
      albumId: input.albumId,
      planBytes,
      nowMs,
      scopeKey,
      schedule: isScheduled ? schedule : null,
    });

    await opfsStaging.createJobDir(jobId);
    await opfsStaging.writeSnapshot(jobId, initialized.bodyBytes, initialized.checksum);

    const job = createInMemoryJob(initialized.bodyBytes, initialized.checksum);
    this.jobs.set(jobId, job);
    this.jobOutputModes.set(jobId, outputMode);
    if (input.source) {
      this.jobSources.set(jobId, input.source);
    }
    if (input.thumbnails && input.thumbnails.length > 0) {
      this.jobThumbnailManifests.set(jobId, input.thumbnails);
    }
    // ZK-safe: only the scope prefix and schedule kind are logged.
    log.info('Job started', {
      jobId: shortId(jobId),
      outputMode: outputMode.kind,
      scopePrefix: scopeKey.slice(0, scopeKey.indexOf(':')),
      scheduleKind: schedule?.kind ?? 'immediate',
    });
    this.emitJobChanged(job);

    if (isScheduled) {
      // Hand off to the manager. The job's persisted phase stays at `Idle`
      // until the manager dispatches it via `dispatchScheduledJob` (which
      // emits PlanReady → Preparing → Running). Drivers do NOT spin yet.
      this.scheduledAt.set(jobId, nowMs);
      this.scheduleManager().add({ jobId, schedule, scheduledAtMs: nowMs });
      return { jobId };
    }

    // Immediate path (existing behaviour): apply PlanReady inline.
    const idleState = extractStateValue(initialized.bodyBytes);
    const eventBytes = encodeStartRequestedEvent(jobIdBytes, input.albumId);
    const applied = await rustApplyDownloadEvent(encodeCbor(idleState), eventBytes);
    const updatedBody = patchSnapshotState(initialized.bodyBytes, applied.newStateBytes, Date.now());
    const committed = await rustCommitDownloadSnapshot(updatedBody);
    await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);
    const updated = createInMemoryJob(updatedBody, committed.checksum);
    this.jobs.set(jobId, updated);
    this.emitJobChanged(updated);
    await this.sendEvent(jobId, { kind: 'PlanReady' });
    this.scheduleJobDriver(jobId);
    return { jobId };
  }

  /**
   * Lazy-build the schedule manager. The first call also `start()`s it so
   * timers + visibility/online listeners attach exactly once.
   */
  private scheduleManager(): ScheduleManager {
    if (this.scheduleManagerInstance) return this.scheduleManagerInstance;
    const deps: ScheduleManagerDeps = {
      captureContext: (scheduledAtMs: number): Promise<ScheduleContext> => captureScheduleContext(scheduledAtMs),
      dispatch: (jobId: string, evaluation: ScheduleEvaluation): void => {
        this.lastEvaluations.set(jobId, evaluation);
        this.dispatchScheduledJob(jobId).catch((error: unknown) => {
          log.warn('Scheduled dispatch failed', {
            jobId: shortId(jobId),
            errorName: error instanceof Error ? error.name : 'Unknown',
          });
        });
      },
      onVisibilityChange: (handler: () => void): (() => void) => {
        if (typeof self === 'undefined' || typeof (self as unknown as { addEventListener?: unknown }).addEventListener !== 'function') {
          return (): void => undefined;
        }
        const target = self as unknown as { addEventListener: (type: string, h: () => void) => void; removeEventListener: (type: string, h: () => void) => void };
        target.addEventListener('visibilitychange', handler);
        return (): void => target.removeEventListener('visibilitychange', handler);
      },
      onOnlineChange: (handler: () => void): (() => void) => {
        if (typeof self === 'undefined' || typeof (self as unknown as { addEventListener?: unknown }).addEventListener !== 'function') {
          return (): void => undefined;
        }
        const target = self as unknown as { addEventListener: (type: string, h: () => void) => void; removeEventListener: (type: string, h: () => void) => void };
        target.addEventListener('online', handler);
        target.addEventListener('offline', handler);
        return (): void => {
          target.removeEventListener('online', handler);
          target.removeEventListener('offline', handler);
        };
      },
      setTimer: (callback, ms): unknown => setInterval(callback, ms) as unknown,
      clearTimer: (handle): void => {
        if (handle !== null && handle !== undefined) {
          clearInterval(handle as ReturnType<typeof setInterval>);
        }
      },
    };
    this.scheduleManagerInstance = new ScheduleManager(deps);
    this.scheduleManagerInstance.start();
    return this.scheduleManagerInstance;
  }

  /**
   * Transition a Scheduled (Idle + schedule) job into the active pipeline.
   *
   * Mirrors the immediate-startJob sequence: apply `StartRequested`
   * (Idle → Preparing) inline, then fire `PlanReady` (Preparing → Running)
   * through the normal event path so subscribers + driver wake up.
   *
   * Idempotent: if the job is missing or no longer Idle (e.g. user already
   * hit `forceStartJob`, or the job was cancelled), the call is a no-op.
   */
  private async dispatchScheduledJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state.phase !== 'Idle') return;
    this.scheduledAt.delete(jobId);
    const jobIdBytes = hexToJobIdBytes(jobId);
    const idleState = extractStateValue(job.snapshotBytes);
    const eventBytes = encodeStartRequestedEvent(jobIdBytes, job.albumId);
    const applied = await rustApplyDownloadEvent(encodeCbor(idleState), eventBytes);
    const updatedBody = patchSnapshotState(job.snapshotBytes, applied.newStateBytes, Date.now());
    const committed = await rustCommitDownloadSnapshot(updatedBody);
    await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);
    const updated = createInMemoryJob(updatedBody, committed.checksum);
    this.jobs.set(jobId, updated);
    this.emitJobChanged(updated);
    await this.sendEvent(jobId, { kind: 'PlanReady' });
    this.scheduleJobDriver(jobId);
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
      this.jobSources.delete(jobId);
      this.jobExportFailures.delete(jobId);
      this.pausedNoSourceVisitorJobs.delete(jobId);
      this.jobThumbnailManifests.delete(jobId);
      this.thumbnailStreamerInstance?.stop(jobId);
      this.emitProgress(summaryToProgress(updated));
      this.broadcast(updated);
      return { phase: updated.state.phase };
    }

    if (updated.state.phase === 'Done' || updated.state.phase === 'Errored' || updated.state.phase === 'Cancelled') {
      // Stop the in-app thumbnail loop and revoke its blob URLs. Manifest
      // is dropped lazily on next GC / hard-cancel; we keep it so a brief
      // re-subscribe (e.g. tray re-render) doesn't no-op silently.
      this.thumbnailStreamerInstance?.stop(jobId);
    }
    this.emitJobChanged(updated);
    return { phase: updated.state.phase };
  }

  /** Pause a running job. */
  pauseJob(jobId: string): Promise<{ phase: DownloadPhase }> {
    this.jobAborts.get(jobId)?.abort();
    this.scheduleManagerInstance?.remove(jobId);
    this.scheduledAt.delete(jobId);
    return this.sendEvent(jobId, { kind: 'PauseRequested' });
  }

  /** Resume a paused, reconstructed-running, or finalizing job. */
  async resumeJob(jobId: string, opts?: { readonly mode?: DownloadOutputMode }): Promise<{ phase: DownloadPhase }> {
    this.assertInitialized();
    if (this.pausedNoSourceVisitorJobs.has(jobId)) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.DownloadIllegalState,
        'Visitor job has no source strategy; rebind via the share link first',
      );
    }
    if (opts?.mode) {
      this.jobOutputModes.set(jobId, opts.mode);
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      // Falls through to sendEvent which throws JobNotFound for missing jobs.
      return this.sendEvent(jobId, { kind: 'ResumeRequested' });
    }
    const phase = job.state.phase;
    if (phase === 'Running') {
      // Reconstructed Running with no live driver: spin one now (using whatever
      // mode was just registered, or keepOffline if none).
      this.scheduleJobDriver(jobId);
      return { phase: 'Running' };
    }
    if (phase === 'Finalizing') {
      // Rust state machine forbids Finalizing -> Paused/Running. We re-run
      // the finalizer over already-staged photos and let it transition via
      // FinalizationDone (or ErrorEncountered on failure).
      this.scheduleFinalizingResume(jobId);
      return { phase: 'Finalizing' };
    }
    return this.sendEvent(jobId, { kind: 'ResumeRequested' });
  }

  /** Cancel a job; hard cancel also purges OPFS staging. */
  async cancelJob(jobId: string, opts: { readonly soft: boolean }): Promise<{ phase: DownloadPhase }> {
    this.jobAborts.get(jobId)?.abort();
    this.scheduleManagerInstance?.remove(jobId);
    this.scheduledAt.delete(jobId);
    this.lastEvaluations.delete(jobId);
    return this.sendEvent(jobId, { kind: 'CancelRequested', soft: opts.soft });
  }

  /**
   * Re-attach a `SourceStrategy` to a reconstructed visitor job after the
   * user has opened the matching share link.
   *
   * Rejects with `IllegalState` if:
   *   - the job is unknown,
   *   - the job is not currently `pausedNoSource`,
   *   - or the supplied source's `scopeKey` does not match the persisted
   *     job's `scopeKey` (defensive cross-link guard).
   *
   * On success the job is removed from `pausedNoSourceVisitorJobs` and
   * `resumeJob` proceeds normally on the caller's next click.
   */
  async rebindJobSource(jobId: string, source: SourceStrategy): Promise<void> {
    this.assertInitialized();
    const job = this.requireJob(jobId);
    if (!this.pausedNoSourceVisitorJobs.has(jobId)) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.DownloadIllegalState,
        'Job is not paused-no-source; rebind is a no-op',
      );
    }
    if (source.getScopeKey() !== job.scopeKey) {
      log.warn('Rebind rejected: scope mismatch', {
        jobId: shortId(jobId),
        sourcePrefix: scopeKeyPrefix(source.getScopeKey()),
        jobPrefix: scopeKeyPrefix(job.scopeKey),
      });
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.DownloadIllegalState,
        'Source strategy scope does not match job scope',
      );
    }
    this.jobSources.set(jobId, source);
    this.pausedNoSourceVisitorJobs.delete(jobId);
    log.info('Rebound visitor job source', {
      jobId: shortId(jobId),
      scopePrefix: scopeKeyPrefix(job.scopeKey),
    });
    this.emitJobChanged(job);
  }

  /** List all known in-memory + OPFS jobs. */
  async listJobs(): Promise<JobSummary[]> {
    this.assertInitialized();
    await this.reconcilePersistedJobs();
    return [...this.jobs.values()]
      .map((job) => toJobSummary(job, this.lastEvaluations.get(job.jobId) ?? null))
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  /** List non-terminal jobs that should surface in the resume prompt. */
  // TODO(p3-visitor-resume-prompt): when surfacing a resumable visitor
  // job whose linkId/grant the user no longer has client-side keys for, the
  // restore prompt must offer "discard" only, not "resume", so the user is
  // not stuck staring at a download they cannot complete.
  async listResumableJobs(): Promise<ResumableJobSummary[]> {
    this.assertInitialized();
    await this.reconcilePersistedJobs();
    return [...this.jobs.values()]
      .filter((job) => this.isJobResumable(job))
      .map((job) => toResumableJobSummary(
        job,
        this.pausedNoSourceVisitorJobs.has(job.jobId),
        this.lastEvaluations.get(job.jobId) ?? null,
      ))
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  /**
   * Predicate: should this job appear in the resume prompt?
   *
   * - Finalizing always surfaces (worker may have crashed mid-finalize).
   * - Running surfaces ONLY when the job has no in-memory output mode, i.e.
   *   was reconstructed from OPFS (live drivers always have a mode entry).
   * - Paused/Preparing surface when at least one photo is done.
   */
  private isJobResumable(job: InMemoryJob): boolean {
    const phase = job.state.phase;
    // Visitor pausedNoSource: always surface so the user can Discard or
    // re-bind via the share-link tab regardless of progress.
    if (this.pausedNoSourceVisitorJobs.has(job.jobId)) {
      return phase !== 'Done' && phase !== 'Cancelled' && phase !== 'Errored';
    }
    if (phase === 'Finalizing') return true;
    if (phase === 'Running') return !this.jobOutputModes.has(job.jobId);
    if (phase === 'Paused' || phase === 'Preparing') {
      return job.photos.some((photo) => photo.status === 'done');
    }
    return false;
  }

  /** Compute a local album diff from the persisted plan and current manifest. */
  async computeAlbumDiff(jobId: string, current: CurrentAlbumManifest): Promise<AlbumDiff> {
    this.assertInitialized();
    let job: InMemoryJob | null | undefined = this.jobs.get(jobId);
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
    return job ? toJobSummary(job, this.lastEvaluations.get(jobId) ?? null) : null;
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

  /**
   * Subscribe to in-app thumbnail Blob URLs for a job. The worker owns the
   * underlying blob URLs and revokes them via the streamer's stop semantics
   * (last subscriber gone, job terminal, or explicit cancel).
   *
   * NOT exported: blob URLs returned here MUST NOT be wired into any
   * finalizer or export sink.
   */
  async subscribeToThumbnails(
    jobId: string,
    callback: (photoId: string, blobUrl: string) => void,
  ): Promise<{ unsubscribe: () => void }> {
    this.assertInitialized();
    const streamer = this.thumbnailStreamer();
    const unsubscribe = streamer.subscribe(jobId, callback);
    return {
      unsubscribe: Comlink.proxy((): void => {
        try { unsubscribe(); } catch { /* best-effort */ }
      }),
    };
  }

  /**
   * Lazy-build the singleton thumbnail streamer. Wires deps to the existing
   * source strategy (auth/share-link) and crypto pool so visitor + auth
   * jobs share one execution path.
   */
  private thumbnailStreamer(): ThumbnailStreamer {
    if (this.thumbnailStreamerInstance) return this.thumbnailStreamerInstance;
    const sourceFor = (jobId: string): SourceStrategy =>
      this.jobSources.get(jobId) ?? this.getDefaultAuthSource();
    const self = this;
    this.thumbnailStreamerInstance = createThumbnailStreamer({
      fetchShard: async (shardId, signal): Promise<Uint8Array> => {
        // Fallback for tests / legacy entries. Real coordinator entries are
        // bound below to the job-local source captured when the stream starts.
        return self.getDefaultAuthSource().fetchShard(shardId, signal);
      },
      resolveThumbKey: async (_photoId, epochId): Promise<Uint8Array> => {
        const epoch = Number.parseInt(epochId, 10);
        return self.getDefaultAuthSource().resolveKey('', Number.isFinite(epoch) ? epoch : 0);
      },
      decryptShard: async (bytes, key): Promise<Uint8Array> => {
        const pool = await getCryptoPoolForCoordinator();
        return pool.decryptShard(bytes, key);
      },
      resolveJobThumbnails: async function* (jobId: string): AsyncIterable<ThumbnailManifestEntry> {
        const manifest = self.jobThumbnailManifests.get(jobId) ?? [];
        const job = self.jobs.get(jobId);
        const source = sourceFor(jobId);
        const albumId = job?.albumId ?? '';
        for (const entry of manifest) {
          yield {
            ...entry,
            fetchShard: (shardId, signal) => source.fetchShard(shardId, signal),
            resolveThumbKey: (_photoId, epochId) => {
              const epoch = Number.parseInt(epochId, 10);
              return source.resolveKey(albumId, Number.isFinite(epoch) ? epoch : 0);
            },
          };
        }
      },
    });
    return this.thumbnailStreamerInstance;
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
      this.jobSources.delete(jobId);
      this.jobExportFailures.delete(jobId);
      this.pausedNoSourceVisitorJobs.delete(jobId);
      this.jobThumbnailManifests.delete(jobId);
      this.thumbnailStreamerInstance?.stop(jobId);
    }
    return { purged: result.purged };
  }

  /** Register or clear the main-thread save-target factory. See {@link CoordinatorWorkerApi}. */
  setSaveTargetProvider(provider: RemoteSaveTargetProvider | null): Promise<void> {
    this.saveTargetProvider = provider;
    return Promise.resolve();
  }

  /**
   * Override a Scheduled job's gate and dispatch it immediately.
   *
   * - Unknown job id: resolves quietly (idempotent across tab restarts; the
   *   tray's Start-now button must not throw if the user double-clicks).
   * - Already-running / paused / finalizing / terminal: no-op.
   * - Scheduled (Idle + present in manager): remove from manager and emit
   *   PlanReady → drives Preparing → Running on the next tick.
   */
  async forceStartJob(jobId: string): Promise<void> {
    this.assertInitialized();
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.scheduleManagerInstance?.remove(jobId);
    this.scheduledAt.delete(jobId);
    this.lastEvaluations.delete(jobId);
    if (job.state.phase !== 'Idle') return;
    await this.dispatchScheduledJob(jobId);
  }

  /**
   * Replace a job's conditional schedule.
   *
   * Patches CBOR snapshot key 11, re-registers with the manager, and
   * triggers an immediate re-evaluation. Pass `null` (or kind=immediate)
   * to clear the gate; the next tick will dispatch the job.
   *
   * Throws `JobNotFound` for unknown jobs.
   */
  async updateJobSchedule(jobId: string, schedule: DownloadSchedule | null): Promise<void> {
    this.assertInitialized();
    const job = this.requireJob(jobId);
    const normalized = schedule && schedule.kind !== 'immediate' ? schedule : null;
    const action = await this.withJobLock(jobId, async () => {
      const updatedBody = patchSnapshotSchedule(job.snapshotBytes, normalized, Date.now());
      const committed = await rustCommitDownloadSnapshot(updatedBody);
      await opfsStaging.writeSnapshot(jobId, updatedBody, committed.checksum);
      const updated = createInMemoryJob(updatedBody, committed.checksum);
      this.jobs.set(jobId, updated);
      // Always remove first to avoid a double-registration in the manager.
      this.scheduleManagerInstance?.remove(jobId);
      this.lastEvaluations.delete(jobId);
      this.emitJobChanged(updated);
      if (normalized && updated.state.phase === 'Idle') {
        const scheduledAtMs = this.scheduledAt.get(jobId) ?? Date.now();
        this.scheduledAt.set(jobId, scheduledAtMs);
        this.scheduleManager().add({ jobId, schedule: normalized, scheduledAtMs });
        return 'evaluate' as const;
      }
      if (normalized === null && updated.state.phase === 'Idle') {
        this.scheduledAt.delete(jobId);
        return 'dispatch' as const;
      }
      this.scheduledAt.delete(jobId);
      return 'noop' as const;
    });
    if (action === 'evaluate') {
      // Trigger a re-evaluation outside the per-job lock so the manager's
      // sync `dispatch` callback can re-acquire it without deadlocking.
      void this.scheduleManager().evaluateAll().catch(() => undefined);
    } else if (action === 'dispatch') {
      // Schedule cleared on an Idle job ⇒ dispatch right away. Outside the
      // lock so dispatchScheduledJob's sendEvent can re-acquire.
      await this.dispatchScheduledJob(jobId);
    }
  }

  /** Dispatch to the appropriate finalizer for this job's output mode. */
  private async runFinalizer(jobId: string, mode: DownloadOutputMode, signal: AbortSignal): Promise<void> {
    switch (mode.kind) {
      case 'keepOffline':
        return;
      case 'zip':
        await this.runZipFinalizer(jobId, mode.fileName, signal);
        return;
      case 'perFile':
        await this.runPerFileFinalizer(jobId, mode.strategy, signal);
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
        const sink = await provider.openZipSaveTarget(name);
        return sinkToWritableStream(sink);
      },
    };
    await runZipFinalizerForCoordinator({ jobId, entries }, fileName, deps, signal);
  }

  private async runPerFileFinalizer(jobId: string, strategy: PerFileStrategy, signal: AbortSignal): Promise<void> {
    const provider = this.saveTargetProvider;
    if (!provider) {
      throw new Error('No save-target provider registered for per-file finalizer');
    }
    const job = this.requireJob(jobId);
    const entries = job.plan.map((entry) => ({ photoId: entry.photoId, filename: entry.filename }));
    const deps: PerFileFinalizerDeps = {
      readPhotoStream: opfsStaging.readPhotoStream,
      getPhotoFileLength: opfsStaging.getPhotoFileLength,
      openPerFileSaveTarget: async (selectedStrategy, photos) => {
        const remote = await provider.openPerFileSaveTarget(selectedStrategy, photos);
        return {
          async writeOne(photoId, filename, sizeBytes, stream, perPhotoSignal): Promise<void> {
            const sink = await remote.openOne(photoId, filename, sizeBytes);
            await stream.pipeTo(sinkToWritableStream(sink), { signal: perPhotoSignal });
          },
          async finalize(): Promise<void> {
            await remote.finalize();
          },
          async abort(): Promise<void> {
            await remote.abort();
          },
        };
      },
      recordPhotoFailure: async (_recordJobId, photoId, reason): Promise<void> => {
        // Track export-side failure in-memory so failureCount surfaces it
        // without mutating per-photo source/staging status. Successfully
        // staged photos must remain done so OPFS bytes can be reused.
        const map = this.jobExportFailures.get(jobId) ?? new Map<string, DownloadErrorReason>();
        map.set(photoId, reason);
        this.jobExportFailures.set(jobId, map);
        const job = this.jobs.get(jobId);
        const photo = job?.photos.find((candidate) => candidate.photoId === photoId);
        if (!photo || photo.status === 'done' || photo.status === 'skipped') {
          if (job) this.emitJobChanged(job);
          return;
        }
        await this.transitionPhoto(jobId, photoId, { kind: 'failed', reason });
      },
    };
    await runPerFileFinalizerForCoordinator({ jobId, entries }, strategy, deps, signal);
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
        }, this.pipelineDeps(pool, this.jobSources.get(jobId) ?? this.getDefaultAuthSource()));
        await this.handlePhotoOutcome(jobId, photo.photoId, outcome);
      });

      const latest = this.jobs.get(jobId);
      if (!abortController.signal.aborted && latest?.state.phase === 'Running') {
        await this.sendEvent(jobId, { kind: 'AllPhotosDone' });
        try {
          const mode = this.jobOutputModes.get(jobId) ?? { kind: 'keepOffline' };
          await this.runFinalizer(jobId, mode, abortController.signal);
          await this.sendEvent(jobId, { kind: 'FinalizationDone' });
          // Non-blocking opportunistic trim after a successful job completion.
          void this.shardMirror.trim().catch(() => undefined);
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

  private getDefaultAuthSource(): SourceStrategy {
    if (this.defaultAuthSource === null) {
      this.defaultAuthSource = createAuthenticatedSourceStrategy(this.accountId);
    }
    return this.defaultAuthSource;
  }

  private pipelineDeps(pool: CryptoPool, source: SourceStrategy): Parameters<typeof executePhotoTask>[1] {
    return {
      pool,
      fetchShards: (shardIds: string[], signal: AbortSignal): Promise<Uint8Array[]> => source.fetchShards(shardIds, signal),
      getEpochSeed: (albumId: string, epochId: number): Promise<Uint8Array> => source.resolveKey(albumId, epochId),
      writePhotoChunk: opfsStaging.writePhotoChunk,
      truncatePhoto: opfsStaging.truncatePhotoTo,
      getPhotoFileLength: opfsStaging.getPhotoFileLength,
      reportBytesWritten: (jobId: string, photoId: string, bytesWritten: number): void => {
        this.handleBytesWritten(jobId, photoId, bytesWritten);
      },
      mirror: this.shardMirror,
      decryptCache: this.decryptCache,
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
      if (job.state.phase !== 'Running' && !(job.state.phase === 'Finalizing' && status.kind === 'failed') && status.kind !== 'pending') {
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
    await ensureScopeKeySodiumReady();
    const reconstructedJobs = await this.reconcilePersistedJobs();
    await this.sweepStaleVisitorJobsOnStartup();
    this.markPausedNoSourceVisitorJobs();
    this.reregisterScheduledJobs();
    this.initialized = true;
    // Intentionally NOT auto-spinning drivers for reconstructed jobs:
    // the Rust snapshot does not persist the user's chosen output mode, so
    // resuming silently would discard the user's pick and finalize as
    // keepOffline. Reconstructed jobs surface via listResumableJobs() and
    // the UI must call resumeJob({ mode }) once the user re-picks.
    log.info('Coordinator initialized', { reconstructedJobs });
    // Enforce mirror budget across runs. Non-blocking; errors are logged and swallowed.
    void this.shardMirror.trim().catch((error: unknown) => {
      log.warn('Shard mirror trim on startup failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
    });
    return { reconstructedJobs };
  }

  /** Diagnostic: return current shard-mirror stats. */
  async getShardMirrorStats(): Promise<ShardMirrorStats> {
    return this.shardMirror.stats();
  }

  /**
   * Clear in-memory derived-key state. Safe to call on logout / scope change.
   * Zeroes every cached epoch key before dropping it.
   */
  clearCaches(): void {
    this.decryptCache.clear();
  }

  private scheduleFinalizingResume(jobId: string): void {
    if (this.jobDrivers.has(jobId)) return;
    const driver = this.runFinalizingResume(jobId)
      .catch((error: unknown) => {
        log.warn('Finalizing-resume driver stopped unexpectedly', {
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

  /**
   * Re-run the finalizer for a job left in Finalizing (e.g. after a worker
   * crash). The Rust state machine forbids Finalizing -> Paused/Running, so
   * we do not transition the state here; we re-execute the finalizer over
   * already-staged photos and emit FinalizationDone on success.
   */
  private async runFinalizingResume(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state.phase !== 'Finalizing') {
      return;
    }
    const abortController = new AbortController();
    this.jobAborts.set(jobId, abortController);
    try {
      const mode = this.jobOutputModes.get(jobId) ?? { kind: 'keepOffline' };
      await this.runFinalizer(jobId, mode, abortController.signal);
      await this.sendEvent(jobId, { kind: 'FinalizationDone' });
    } catch (err) {
      log.warn('Finalizing-resume failed', {
        jobId: shortId(jobId),
        errorName: err instanceof Error ? err.name : 'Unknown',
      });
      await this.sendEvent(jobId, { kind: 'ErrorEncountered', reason: 'IllegalState' });
    } finally {
      if (this.jobAborts.get(jobId) === abortController) {
        this.jobAborts.delete(jobId);
      }
    }
  }

  /**
   * Sweep abandoned visitor-scope OPFS jobs on startup.
   *
   * Visitor jobs are coupled to a share-link/grant the user may never come
   * back to. After {@link VISITOR_GC_TTL_MS} (terminal) or
   * {@link VISITOR_RESUME_GRACE_MS} (non-terminal) the staging directory is
   * deleted so an offline tab cannot accumulate OPFS storage indefinitely.
   *
   * Auth and legacy jobs are never touched here; they have their own
   * retention paths via the explicit `gc({ maxAgeMs })` API.
   */
  private async sweepStaleVisitorJobsOnStartup(): Promise<void> {
    const candidates = [...this.jobs.values()].map((job) => ({
      jobId: job.jobId,
      scopeKey: job.scopeKey,
      phase: job.state.phase,
      lastUpdatedAtMs: job.lastUpdatedAtMs,
    }));
    const stale = selectStaleVisitorJobs(candidates, {
      nowMs: Date.now(),
      ttlMs: VISITOR_GC_TTL_MS,
      graceMs: VISITOR_RESUME_GRACE_MS,
    });
    if (stale.length === 0) return;
    for (const jobId of stale) {
      try {
        await opfsStaging.purgeJob(jobId);
      } catch (error) {
        log.warn('Visitor GC purge failed', {
          jobId: shortId(jobId),
          errorName: error instanceof Error ? error.name : 'Unknown',
        });
      }
      this.jobs.delete(jobId);
      this.jobOutputModes.delete(jobId);
      this.jobSources.delete(jobId);
      this.jobExportFailures.delete(jobId);
      this.pausedNoSourceVisitorJobs.delete(jobId);
    }
    log.info('Visitor GC swept stale jobs', { count: stale.length });
  }

  /**
   * After reconcile, mark every non-terminal visitor-scope job as
   * `pausedNoSource` because the in-memory `SourceStrategy` did not
   * survive the worker restart. The resume prompt will surface these with
   * Discard-only actions until the user re-opens the matching share link.
   */
  private markPausedNoSourceVisitorJobs(): void {
    for (const job of this.jobs.values()) {
      if (!isVisitorScopeKey(job.scopeKey)) continue;
      if (this.jobSources.has(job.jobId)) continue;
      const phase = job.state.phase;
      if (phase === 'Done' || phase === 'Cancelled' || phase === 'Errored') continue;
      this.pausedNoSourceVisitorJobs.add(job.jobId);
    }
    if (this.pausedNoSourceVisitorJobs.size > 0) {
      log.info('Marked visitor jobs paused-no-source', {
        count: this.pausedNoSourceVisitorJobs.size,
      });
    }
  }

  /**
   * After reconcile, re-arm every reconstructed `Idle + schedule` job in the
   * schedule manager so a tab reload does not drop the user's pending
   * conditional download. Visitor pausedNoSource jobs are skipped — the
   * tray surfaces them with Discard-only actions until the share link is
   * re-opened (see `markPausedNoSourceVisitorJobs`).
   */
  private reregisterScheduledJobs(): void {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state.phase !== 'Idle') continue;
      if (job.schedule === null) continue;
      if (this.pausedNoSourceVisitorJobs.has(job.jobId)) continue;
      const scheduledAtMs = job.createdAtMs;
      this.scheduledAt.set(job.jobId, scheduledAtMs);
      this.scheduleManager().add({ jobId: job.jobId, schedule: job.schedule, scheduledAtMs });
      count += 1;
    }
    if (count > 0) {
      log.info('Re-registered scheduled jobs with manager', { count });
    }
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

  /**
   * Cross-tab job-changed broadcast.
   *
   * The payload carries the job's tray `scopeKey` so subscribers can drop
   * messages for scopes they are not viewing — visitor tabs MUST NOT be
   * woken up by authenticated-tab events, and vice versa.
   *
   * Channel-name partitioning was considered (one channel per scope-prefix)
   * but rejected because:
   *   - The receive-side filter is already required for the legacy → auth
   *     migration safety net.
   *   - Multiple channel objects would multiply listeners + cleanup paths
   *     without strengthening the invariant.
   *   - The scope-key hex is a pseudonymous BLAKE2b-128 of identity bytes
   *     and is already on `JobSummary`; broadcasting it adds no leakage.
   */
  private broadcast(job: InMemoryJob): void {
    const message: DownloadJobsBroadcastMessage = {
      kind: 'job-changed',
      jobId: job.jobId,
      phase: job.state.phase,
      lastUpdatedAtMs: job.lastUpdatedAtMs,
      scopeKey: job.scopeKey,
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
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'job-changed'
    && typeof v.jobId === 'string'
    && typeof v.phase === 'string'
    && typeof v.lastUpdatedAtMs === 'number'
    && typeof v.scopeKey === 'string';
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
    scopeKey: view.scopeKey,
    lastErrorReason: view.lastErrorReason,
    schedule: view.schedule,
  };
}

function toJobSummary(job: InMemoryJob, scheduleEvaluation: ScheduleEvaluation | null = null): JobSummary {
  return {
    jobId: job.jobId,
    albumId: job.albumId,
    phase: job.state.phase,
    photoCounts: countPhotos(job.photos),
    failureCount: job.failureLog.length,
    createdAtMs: job.createdAtMs,
    lastUpdatedAtMs: job.lastUpdatedAtMs,
    scopeKey: job.scopeKey,
    lastErrorReason: job.lastErrorReason,
    schedule: job.schedule,
    scheduleEvaluation,
  };
}

function toResumableJobSummary(job: InMemoryJob, pausedNoSource: boolean, scheduleEvaluation: ScheduleEvaluation | null = null): ResumableJobSummary {
  const summary = toJobSummary(job, scheduleEvaluation);
  return {
    ...summary,
    photosDone: summary.photoCounts.done,
    photosTotal: job.photos.length,
    bytesWritten: job.photos.reduce((total, photo) => total + photo.bytesWritten, 0),
    lastUpdatedAtMs: job.lastUpdatedAtMs,
    pausedNoSource,
  };
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
  // Snapshot key 10 = scope_key (v2). v1 snapshots are migrated by Rust to
  // synthesize a `legacy:<jobIdHex>` value, so this is always present after
  // load. Treat unexpected absence as `legacy:<jobIdHex>` for robustness.
  const scopeKey = optionalMapValue(fields, 10);
  // Snapshot key 11 = schedule (v3, optional). Absent or Null ⇒ Immediate.
  const scheduleValue = optionalMapValue(fields, 11);
  return {
    jobId,
    albumId: uuidBytesToString(albumBytes),
    createdAtMs: expectUint(requiredMapValue(fields, 3)),
    lastUpdatedAtMs: expectUint(requiredMapValue(fields, 4)),
    state: parseState(requiredMapValue(fields, 5)),
    plan: expectArray(requiredMapValue(fields, 6)).map(parsePlanEntry),
    photos: expectArray(requiredMapValue(fields, 7)).map(parsePhoto),
    failureLog: expectArray(requiredMapValue(fields, 8)).map(parseFailure),
    scopeKey: scopeKey === null ? `legacy:${jobId}` : expectText(scopeKey),
    lastErrorReason: lastFailureReason(expectArray(requiredMapValue(fields, 8))),
    schedule: scheduleValue === null || scheduleValue.kind === 'null' ? null : parseScheduleValue(scheduleValue),
  };
}

/**
 * Decode a CBOR `schedule_value` (snapshot key 11 OR plan-input key 5).
 * Mirrors `decode_schedule` in `mosaic-client/src/download/snapshot.rs`.
 *
 * Throws on unknown kind codes so a corrupt snapshot does not silently
 * become an Immediate job.
 */
function parseScheduleValue(value: CborValue): DownloadSchedule | null {
  const fields = expectMap(value);
  const kind = expectUint(requiredMapValue(fields, 0));
  const rawDelay = requiredMapValue(fields, 3);
  const maxDelayMs = rawDelay.kind === 'null' ? undefined : expectUint(rawDelay);
  switch (kind) {
    case 0:
      return null; // IMMEDIATE
    case 1:
      return maxDelayMs === undefined ? { kind: 'wifi' } : { kind: 'wifi', maxDelayMs };
    case 2:
      return maxDelayMs === undefined ? { kind: 'wifi-charging' } : { kind: 'wifi-charging', maxDelayMs };
    case 3:
      return maxDelayMs === undefined ? { kind: 'idle' } : { kind: 'idle', maxDelayMs };
    case 4: {
      const start = expectUint(requiredMapValue(fields, 1));
      const end = expectUint(requiredMapValue(fields, 2));
      return maxDelayMs === undefined
        ? { kind: 'window', windowStartHour: start, windowEndHour: end }
        : { kind: 'window', windowStartHour: start, windowEndHour: end, maxDelayMs };
    }
    default:
      throw new Error(`Unknown download schedule kind code: ${kind}`);
  }
}

/**
 * Encode a {@link DownloadSchedule} into the canonical CBOR `schedule_value`
 * map. Mirrors `schedule_value` in `mosaic-client/src/download/snapshot.rs`
 * AND `encodeDownloadScheduleValue` in `rust-crypto-core.ts`.
 */
function encodeScheduleValue(schedule: DownloadSchedule): CborValue {
  const maxDelay = schedule.maxDelayMs;
  const maxDelayValue: CborValue = maxDelay === undefined
    ? { kind: 'null' }
    : uintValue(maxDelay);
  switch (schedule.kind) {
    case 'wifi':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(1) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'wifi-charging':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(2) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'idle':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(3) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'window':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(4) },
        { key: uintValue(1), value: uintValue(schedule.windowStartHour ?? 0) },
        { key: uintValue(2), value: uintValue(schedule.windowEndHour ?? 0) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'immediate':
      throw new Error('encodeScheduleValue: immediate schedules are not persisted');
    default: {
      const _exhaustive: never = schedule.kind;
      void _exhaustive;
      throw new Error('encodeScheduleValue: unknown schedule kind');
    }
  }
}

/**
 * Insert/replace/remove key 11 (schedule) in a snapshot CBOR body.
 * Preserves canonical ascending-key order. Used by `updateJobSchedule`.
 */
function patchSnapshotSchedule(snapshotBytes: Uint8Array, schedule: DownloadSchedule | null, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root);
  const filtered = entries.filter((entry) => {
    const key = expectUint(entry.key);
    return key !== 4 && key !== 11;
  });
  filtered.push({ key: uintValue(4), value: uintValue(nowMs) });
  if (schedule && schedule.kind !== 'immediate') {
    filtered.push({ key: uintValue(11), value: encodeScheduleValue(schedule) });
  }
  // Re-sort by ascending uint key for canonical CBOR order.
  filtered.sort((a, b) => expectUint(a.key) - expectUint(b.key));
  return encodeCbor({ kind: 'map', value: filtered });
}

function lastFailureReason(entries: readonly CborValue[]): DownloadErrorReason | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    const reasonValue = optionalMapValue(expectMap(e), 1);
    if (reasonValue === null) continue;
    const code = expectUint(reasonValue);
    return DOWNLOAD_REASON_BY_CODE[code] ?? null;
  }
  return null;
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
  const reasonValue = optionalMapValue(fields, 1);
  let reason: DownloadErrorReason | null = null;
  if (reasonValue !== null) {
    const code = expectUint(reasonValue);
    reason = DOWNLOAD_REASON_BY_CODE[code] ?? null;
  }
  return { atMs: expectUint(requiredMapValue(fields, 2)), reason };
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

function optionalMapValue(entries: readonly CborMapEntry[], key: number): CborValue | null {
  const entry = entries.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  return entry ? entry.value : null;
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

function hexToJobIdBytes(hex: string): Uint8Array {
  if (hex.length !== JOB_ID_HEX_BYTES * 2) {
    throw new Error('Invalid job id hex length');
  }
  const bytes = new Uint8Array(JOB_ID_HEX_BYTES);
  for (let i = 0; i < JOB_ID_HEX_BYTES; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
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
  setRunPerFileFinalizer(fn: typeof defaultRunPerFileFinalizer): void {
    runPerFileFinalizerForCoordinator = fn;
  },
  runJobDriver(worker: CoordinatorWorker, jobId: string): Promise<void> {
    return worker.runJobDriver(jobId);
  },
  getJobSource(worker: CoordinatorWorker, jobId: string): SourceStrategy | null {
    interface SourceMapHolder { readonly jobSources: Map<string, SourceStrategy> }
    return (worker as unknown as SourceMapHolder).jobSources.get(jobId) ?? null;
  },
  awaitScheduledDriver(worker: CoordinatorWorker, jobId: string): Promise<void> {
    interface DriverMapHolder { readonly jobDrivers: Map<string, Promise<void>> }
    const map = (worker as unknown as DriverMapHolder).jobDrivers;
    return map.get(jobId) ?? Promise.resolve();
  },
  getScheduleManager(worker: CoordinatorWorker): ScheduleManager | null {
    interface MgrHolder { readonly scheduleManagerInstance: ScheduleManager | null }
    return (worker as unknown as MgrHolder).scheduleManagerInstance;
  },
  setLastEvaluation(worker: CoordinatorWorker, jobId: string, evaluation: ScheduleEvaluation): void {
    interface EvalHolder { readonly lastEvaluations: Map<string, ScheduleEvaluation> }
    (worker as unknown as EvalHolder).lastEvaluations.set(jobId, evaluation);
  },
};
