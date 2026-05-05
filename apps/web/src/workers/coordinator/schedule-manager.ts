/**
 * Schedule manager — drives conditional download jobs out of the
 * `Scheduled` state when their {@link DownloadSchedule} permits.
 *
 * Designed to be host-agnostic: it does not import the coordinator or any
 * worker globals directly. The coordinator wires it in by providing
 * {@link ScheduleManagerDeps}, then calls `add` / `remove` as jobs come and
 * go. This keeps the manager unit-testable with fake timers.
 *
 * ZK-safe: dispatch payloads carry the evaluation `reason` only, never any
 * job/album metadata.
 */

import type { DownloadSchedule, ScheduleContext, ScheduleEvaluation } from '../../lib/download-schedule';
import { DEFAULT_RETRY_AFTER_MS, evaluateSchedule, isImmediate } from '../../lib/download-schedule';

export interface ScheduledJob {
  readonly jobId: string;
  readonly schedule: DownloadSchedule;
  readonly scheduledAtMs: number;
}

export interface ScheduleManagerDeps {
  /** Capture the current {@link ScheduleContext}; returns a fresh snapshot. */
  captureContext(scheduledAtMs: number): Promise<ScheduleContext>;
  /** Dispatch a `Scheduled -> Pending` transition. Implementations should be idempotent. */
  dispatch(jobId: string, evaluation: ScheduleEvaluation): void;
  /** Subscribe to visibility-change events; returns an unsubscribe fn. May be a no-op. */
  onVisibilityChange?(handler: () => void): () => void;
  /** Subscribe to online/offline events; returns an unsubscribe fn. May be a no-op. */
  onOnlineChange?(handler: () => void): () => void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Periodic re-evaluation cadence, matches `DEFAULT_RETRY_AFTER_MS`. */
export const SCHEDULE_TICK_MS = DEFAULT_RETRY_AFTER_MS;

export class ScheduleManager {
  private readonly jobs = new Map<string, ScheduledJob>();
  private timer: unknown = null;
  private unsubVisibility: (() => void) | null = null;
  private unsubOnline: (() => void) | null = null;
  private started = false;
  private readonly deps: ScheduleManagerDeps;

  public constructor(deps: ScheduleManagerDeps) {
    this.deps = deps;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = this.deps.setTimer(() => {
      void this.evaluateAll();
    }, SCHEDULE_TICK_MS);
    if (this.deps.onVisibilityChange) {
      this.unsubVisibility = this.deps.onVisibilityChange(() => {
        void this.evaluateAll();
      });
    }
    if (this.deps.onOnlineChange) {
      this.unsubOnline = this.deps.onOnlineChange(() => {
        void this.evaluateAll();
      });
    }
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.unsubVisibility?.();
    this.unsubOnline?.();
    this.unsubVisibility = null;
    this.unsubOnline = null;
  }

  /** Track a scheduled job. Immediate-kind jobs are dispatched right away. */
  public add(job: ScheduledJob): void {
    if (isImmediate(job.schedule)) {
      // No need to occupy a slot — synthesize a permissive evaluation and
      // hand the job back to the coordinator.
      this.deps.dispatch(job.jobId, { canStart: true, reason: 'immediate', retryAfterMs: null });
      return;
    }
    this.jobs.set(job.jobId, job);
  }

  /** Stop tracking a job (e.g. cancelled or already running). */
  public remove(jobId: string): void {
    this.jobs.delete(jobId);
  }

  /** Visible for tests / debugging — number of jobs currently scheduled. */
  public size(): number {
    return this.jobs.size;
  }

  /**
   * Re-evaluate every scheduled job exactly once. Jobs that pass evaluation
   * are dispatched and removed; the rest stay queued.
   */
  public async evaluateAll(): Promise<void> {
    // Snapshot the entries first so we don't observe concurrent `add` /
    // `remove` operations triggered synchronously by `dispatch`.
    const pending = Array.from(this.jobs.values());
    for (const job of pending) {
      // A job may have been removed between iterations (e.g. dispatch of
      // a previous job synchronously cancelled this one).
      if (!this.jobs.has(job.jobId)) continue;
      const ctx = await this.deps.captureContext(job.scheduledAtMs);
      const evaluation = evaluateSchedule(job.schedule, ctx);
      if (evaluation.canStart) {
        this.jobs.delete(job.jobId);
        this.deps.dispatch(job.jobId, evaluation);
      }
    }
  }
}
