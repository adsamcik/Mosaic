import { useCallback, useMemo } from "react";
import { useDownloadManager } from "./useDownloadManager";
import type { DownloadSchedule, ScheduleEvaluation } from "../lib/download-schedule";

/**
 * Convenience facade over {@link useDownloadManager} for components that
 * only need to drive ONE job's schedule (badge, edit dialog, force-start
 * button, cancel).
 *
 * Returns null fields when the job is not currently visible to the
 * download manager (unknown id, cross-scope, terminal + dismissed). Action
 * helpers are still callable in that case — they will reject through the
 * worker error path with `JobNotFound`.
 */
export interface UseDownloadScheduleResult {
  /** Currently-attached schedule, or null when the job is Immediate / unknown. */
  readonly schedule: DownloadSchedule | null;
  /** Most recent ScheduleEvaluation snapshot from the worker manager. */
  readonly evaluation: ScheduleEvaluation | null;
  readonly forceStart: () => Promise<void>;
  readonly updateSchedule: (next: DownloadSchedule | null) => Promise<void>;
  readonly cancel: () => Promise<void>;
}

export function useDownloadSchedule(jobId: string): UseDownloadScheduleResult {
  const manager = useDownloadManager();
  const job = useMemo(
    () => manager.jobs.find((candidate) => candidate.jobId === jobId) ?? null,
    [manager.jobs, jobId],
  );
  const forceStart = useCallback(async (): Promise<void> => {
    await manager.forceStartJob(jobId);
  }, [jobId, manager]);
  const updateSchedule = useCallback(async (next: DownloadSchedule | null): Promise<void> => {
    await manager.updateJobSchedule(jobId, next);
  }, [jobId, manager]);
  const cancel = useCallback(async (): Promise<void> => {
    await manager.cancelJob(jobId, { soft: false });
  }, [jobId, manager]);
  return {
    schedule: job?.schedule ?? null,
    evaluation: job?.scheduleEvaluation ?? null,
    forceStart,
    updateSchedule,
    cancel,
  };
}
