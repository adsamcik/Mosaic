/**
 * Coordinator misc helpers — small standalone utilities extracted from
 * `coordinator.worker.ts` (Sweep 39).
 */
import type {
  CurrentAlbumManifest,
  DownloadJobsBroadcastMessage,
  DownloadFailureView,
  DownloadJobStateView,
  DownloadOutputMode,
  DownloadPhotoCounts,
  DownloadPhotoStateView,
  DownloadErrorReason,
  JobProgressEvent,
  JobSummary,
  RemoteByteSink,
  ResumableJobSummary,
} from '../types';
import type { DownloadSchedule, ScheduleEvaluation } from '../../lib/download-schedule';
import type { DownloadPlanEntry } from './photo-pipeline';
import { parseSnapshotView } from './snapshot-codec';

export const CHANNEL_NAME = 'mosaic-download-jobs';

export interface InMemoryJob {
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

export type SubscriptionCallback = (event: JobProgressEvent) => void;

export function createBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME);
}

export function isDownloadJobsBroadcastMessage(value: unknown): value is DownloadJobsBroadcastMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'job-changed'
    && typeof v.jobId === 'string'
    && typeof v.phase === 'string'
    && typeof v.lastUpdatedAtMs === 'number'
    && typeof v.scopeKey === 'string';
}

export function createInMemoryJob(snapshotBytes: Uint8Array, checksum: Uint8Array): InMemoryJob {
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

export function toJobSummary(
  job: InMemoryJob,
  scheduleEvaluation: ScheduleEvaluation | null = null,
  outputModeKind: DownloadOutputMode['kind'] | undefined = undefined,
): JobSummary {
  const base: JobSummary = {
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
  return outputModeKind !== undefined ? { ...base, outputModeKind } : base;
}

export function toResumableJobSummary(
  job: InMemoryJob,
  pausedNoSource: boolean,
  scheduleEvaluation: ScheduleEvaluation | null = null,
  outputModeKind: DownloadOutputMode['kind'] | undefined = undefined,
): ResumableJobSummary {
  const summary = toJobSummary(job, scheduleEvaluation, outputModeKind);
  return {
    ...summary,
    photosDone: summary.photoCounts.done,
    photosTotal: job.photos.length,
    bytesWritten: job.photos.reduce((total, photo) => total + photo.bytesWritten, 0),
    lastUpdatedAtMs: job.lastUpdatedAtMs,
    pausedNoSource,
  };
}

export function summaryToProgress(job: InMemoryJob): JobProgressEvent {
  return {
    jobId: job.jobId,
    phase: job.state.phase,
    photoCounts: countPhotos(job.photos),
    failureCount: job.failureLog.length,
    lastUpdatedAtMs: job.lastUpdatedAtMs,
  };
}

export function countPhotos(photos: readonly DownloadPhotoStateView[]): DownloadPhotoCounts {
  const counts = { pending: 0, inflight: 0, done: 0, failed: 0, skipped: 0 };
  for (const photo of photos) {
    counts[photo.status] += 1;
  }
  return counts;
}

/** Manifest type re-export consumers occasionally need at the top level. */
export type { CurrentAlbumManifest };

export async function runWithConcurrency<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
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

export function sinkToWritableStream(sink: RemoteByteSink): WritableStream<Uint8Array> {
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
