import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useDownloadManager } from '../../hooks/useDownloadManager';
import type { DownloadPhase, JobSummary, ResumableJobSummary } from '../../workers/types';
import { DownloadJobRow, shortId } from './DownloadJobRow';
import '../../styles/download-tray.css';

export interface DownloadTrayProps {
  /** Optional: control visibility from a parent. Defaults: visible when there are active or recently-completed jobs. */
  readonly forceVisible?: boolean;
}

/**
 * Persistent download tray. Renders nothing when there are no jobs to display.
 * Consumes useDownloadManager() internally; no props needed for the typical case.
 */
export function DownloadTray(props: DownloadTrayProps = {}): JSX.Element | null {
  const { forceVisible = false } = props;
  const { t } = useTranslation();
  const manager = useDownloadManager();
  const [expanded, setExpanded] = useState(false);
  const [dismissedJobIds, setDismissedJobIds] = useState<ReadonlySet<string>>(new Set());
  const [recentDoneJobIds, setRecentDoneJobIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const previousPhasesRef = useRef<Map<string, DownloadPhase>>(new Map());
  const doneTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const cleanups = manager.jobs.map((job) => manager.subscribe(job.jobId));
    return (): void => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [manager.jobs, manager.subscribe]);

  useEffect(() => {
    for (const job of manager.jobs) {
      const previous = previousPhasesRef.current.get(job.jobId);
      previousPhasesRef.current.set(job.jobId, job.phase);
      if (job.phase === 'Done' && previous !== 'Done' && !dismissedJobIds.has(job.jobId) && !doneTimersRef.current.has(job.jobId)) {
        setRecentDoneJobIds((current) => new Set(current).add(job.jobId));
        const timer = window.setTimeout(() => {
          setRecentDoneJobIds((current) => {
            const next = new Set(current);
            next.delete(job.jobId);
            return next;
          });
          doneTimersRef.current.delete(job.jobId);
          setExpanded(false);
        }, 5000);
        doneTimersRef.current.set(job.jobId, timer);
      }
    }
  }, [manager.jobs, dismissedJobIds]);

  useEffect(() => {
    return (): void => {
      for (const timer of doneTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      doneTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return (): void => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const displayedJobs = useMemo(() => {
    return manager.jobs.filter((job) => {
      if (dismissedJobIds.has(job.jobId)) return false;
      if (!isTerminal(job.phase)) return true;
      if (job.phase === 'Done') return forceVisible || recentDoneJobIds.has(job.jobId);
      return forceVisible;
    });
  }, [dismissedJobIds, forceVisible, manager.jobs, recentDoneJobIds]);

  const displayedResumableJobs = useMemo(() => {
    const displayedJobIds = new Set(displayedJobs.map((job) => job.jobId));
    return manager.resumableJobs.filter((job) => !dismissedJobIds.has(job.jobId) && !displayedJobIds.has(job.jobId));
  }, [dismissedJobIds, displayedJobs, manager.resumableJobs]);

  const hasJobsToDisplay = displayedJobs.length > 0 || displayedResumableJobs.length > 0;
  const hasSourceJobs = manager.jobs.length > 0 || manager.resumableJobs.length > 0;
  if ((!hasSourceJobs && !forceVisible) || (!hasJobsToDisplay && !forceVisible)) {
    return null;
  }

  const activeJobs = displayedJobs.filter((job) => !isTerminal(job.phase));
  const mostRecentActiveJob = [...activeJobs].sort((a, b) => b.lastUpdatedAtMs - a.lastUpdatedAtMs)[0];
  const completedCount = displayedJobs.filter((job) => job.phase === 'Done').length;
  const combined = combineCounts(displayedJobs, displayedResumableJobs);
  const progressLabel = t('download.tray.photoProgress', { done: combined.done, total: combined.total });
  const etaLabel = combined.done > 0 && combined.done < combined.total
    ? t('download.tray.etaSimple', { remaining: combined.total - combined.done })
    : t('download.tray.etaPending');

  const runAction = (operation: () => Promise<unknown>): void => {
    setActionError(null);
    void operation().catch((caught: unknown) => {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  const pauseJob = (jobId: string): void => runAction(async () => manager.pauseJob(jobId));
  const resumeJob = (jobId: string): void => runAction(async () => manager.resumeJob(jobId));
  const cancelSoft = (jobId: string): void => runAction(async () => manager.cancelJob(jobId, { soft: true }));
  const cancelHard = (jobId: string): void => {
    setDismissedJobIds((current) => new Set(current).add(jobId));
    runAction(async () => manager.cancelJob(jobId, { soft: false }));
  };
  const dismissCompleted = (jobId: string): void => {
    setDismissedJobIds((current) => new Set(current).add(jobId));
    const timer = doneTimersRef.current.get(jobId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      doneTimersRef.current.delete(jobId);
    }
    setRecentDoneJobIds((current) => {
      const next = new Set(current);
      next.delete(jobId);
      return next;
    });
  };

  return (
    <aside className={`download-tray ${expanded ? 'download-tray--expanded' : ''}`} role="region" aria-label={t('download.tray.title')}>
      <div className="download-tray-live" aria-live="polite">
        {actionError ? t('download.tray.actionError', { error: actionError }) : `${progressLabel} ${etaLabel}`}
      </div>
      <div className="download-tray-strip">
        <button
          type="button"
          className="download-tray-summary"
          aria-expanded={expanded}
          aria-controls="download-tray-panel"
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="download-tray-status-icon" aria-hidden="true">{summaryIcon(activeJobs, completedCount)}</span>
          <span className="download-tray-title-text">{t('download.tray.title')}</span>
          <span>{activeJobs.length > 0 ? t('download.tray.active', { count: activeJobs.length }) : t('download.tray.completed')}</span>
          <span>{progressLabel}</span>
          <span className="download-tray-muted">{etaLabel}</span>
          {completedCount > 0 && <span className="download-tray-completed-badge">{t('download.tray.completedBadge', { count: completedCount })}</span>}
        </button>
        {mostRecentActiveJob && (
          <div className="download-tray-strip-actions">
            {mostRecentActiveJob.phase === 'Paused' ? (
              <button type="button" className="download-tray-button" aria-label={t('download.tray.resumeJob')} onClick={() => resumeJob(mostRecentActiveJob.jobId)}>
                {t('download.tray.resume')}
              </button>
            ) : (
              <button type="button" className="download-tray-button" aria-label={t('download.tray.pauseJob')} onClick={() => pauseJob(mostRecentActiveJob.jobId)}>
                {t('download.tray.pause')}
              </button>
            )}
            <button type="button" className="download-tray-button download-tray-button--danger" aria-label={t('download.tray.cancelJob')} onClick={() => cancelSoft(mostRecentActiveJob.jobId)}>
              {t('download.tray.cancel')}
            </button>
          </div>
        )}
        <button type="button" className="download-tray-caret" aria-label={expanded ? t('download.tray.collapse') : t('download.tray.expand')} onClick={() => setExpanded((value) => !value)}>
          {expanded ? '⌄' : '⌃'}
        </button>
      </div>
      {expanded && (
        <div id="download-tray-panel" className="download-tray-panel">
          {displayedJobs.map((job) => (
            <div className="download-tray-job-wrap" key={job.jobId}>
              <DownloadJobRow
                job={job}
                onPause={pauseJob}
                onResume={resumeJob}
                onCancelSoft={cancelSoft}
                onCancelHard={cancelHard}
              />
              {job.phase === 'Done' && (
                <button type="button" className="download-tray-link-button" onClick={() => dismissCompleted(job.jobId)}>
                  {t('download.tray.dismissCompleted', { album: shortId(job.albumId) })}
                </button>
              )}
            </div>
          ))}
          {displayedResumableJobs.map((job) => (
            <ResumableRow key={job.jobId} job={job} onResume={resumeJob} onDiscard={cancelHard} />
          ))}
        </div>
      )}
    </aside>
  );
}

function ResumableRow({ job, onResume, onDiscard }: {
  readonly job: ResumableJobSummary;
  readonly onResume: (jobId: string) => void;
  readonly onDiscard: (jobId: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="download-tray-resumable-row">
      <span className="download-tray-status-icon" aria-hidden="true">↻</span>
      <span>{shortId(job.albumId)}</span>
      <span>{t('download.tray.resumePromptBody', { done: job.photosDone, total: job.photosTotal })}</span>
      <button type="button" className="download-tray-button" onClick={() => onResume(job.jobId)}>{t('download.tray.resumeFromYesterday')}</button>
      <button type="button" className="download-tray-button download-tray-button--danger" onClick={() => onDiscard(job.jobId)}>{t('download.tray.discard')}</button>
    </div>
  );
}

function isTerminal(phase: DownloadPhase): boolean {
  return phase === 'Done' || phase === 'Errored' || phase === 'Cancelled';
}

function combineCounts(jobs: ReadonlyArray<JobSummary>, resumableJobs: ReadonlyArray<ResumableJobSummary>): { readonly done: number; readonly total: number } {
  const jobsTotal = jobs.reduce((sum, job) => sum + job.photoCounts.pending + job.photoCounts.inflight + job.photoCounts.done + job.photoCounts.failed + job.photoCounts.skipped, 0);
  const jobsDone = jobs.reduce((sum, job) => sum + job.photoCounts.done + job.photoCounts.failed + job.photoCounts.skipped, 0);
  const resumableTotal = resumableJobs.reduce((sum, job) => sum + job.photosTotal, 0);
  const resumableDone = resumableJobs.reduce((sum, job) => sum + job.photosDone, 0);
  return { done: jobsDone + resumableDone, total: jobsTotal + resumableTotal };
}

function summaryIcon(activeJobs: ReadonlyArray<JobSummary>, completedCount: number): string {
  if (activeJobs.some((job) => job.phase === 'Running' || job.phase === 'Preparing' || job.phase === 'Finalizing')) return '↓';
  if (activeJobs.some((job) => job.phase === 'Paused')) return 'Ⅱ';
  if (completedCount > 0) return '✓';
  return '↻';
}
