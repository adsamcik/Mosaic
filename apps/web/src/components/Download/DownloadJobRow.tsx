import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { JobProgressEvent, JobSummary } from '../../workers/types';
import { DownloadFailureList, type DownloadFailureListEntry } from './DownloadFailureList';

export interface DownloadJobRowProps {
  /** Job summary to render. Full ids are never displayed. */
  readonly job: JobSummary;
  /** Most recent live progress event for this job, when available. */
  readonly progress?: JobProgressEvent;
  /** Called when the user pauses a running job. */
  readonly onPause: (jobId: string) => void;
  /** Called when the user resumes a paused job. */
  readonly onResume: (jobId: string) => void;
  /** Called when the user requests a soft cancel. */
  readonly onCancelSoft: (jobId: string) => void;
  /** Called when the user requests a hard cancel/discard. */
  readonly onCancelHard: (jobId: string) => void;
  /** Called when the user opens failure details for a job. */
  readonly onShowFailures?: (jobId: string) => void;
  /** Optional display-safe failure rows. Photo ids must be shortened by the caller. */
  readonly failures?: ReadonlyArray<DownloadFailureListEntry>;
}

/** Presentational row for one persistent coordinator download job. */
export function DownloadJobRow({
  job,
  progress,
  onPause,
  onResume,
  onCancelSoft,
  onCancelHard,
  onShowFailures,
  failures = [],
}: DownloadJobRowProps): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const counts = progress?.photoCounts ?? job.photoCounts;
  const phase = progress?.phase ?? job.phase;
  const failureCount = progress?.failureCount ?? job.failureCount;
  const totalPhotos = counts.pending + counts.inflight + counts.done + counts.failed + counts.skipped;
  const finishedPhotos = counts.done + counts.failed + counts.skipped;
  const percentage = totalPhotos > 0 ? Math.round((finishedPhotos / totalPhotos) * 100) : 0;
  const isRunning = phase === 'Running' || phase === 'Preparing' || phase === 'Finalizing';
  const isPaused = phase === 'Paused';
  const isTerminal = phase === 'Done' || phase === 'Cancelled' || phase === 'Errored';
  const statusLabel = t(`download.tray.phase.${phase}`, { defaultValue: phase });
  const safeAlbumId = useMemo(() => shortId(job.albumId), [job.albumId]);

  const handleRowClick = (): void => {
    setExpanded((value) => !value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setExpanded((value) => !value);
    }
  };

  return (
    <div className="download-tray-job" data-testid="download-job-row">
      <div
        className="download-tray-job-main"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleRowClick}
        onKeyDown={handleKeyDown}
      >
        <span className={`download-tray-status-icon download-tray-status-icon--${phase.toLowerCase()}`} aria-hidden="true">
          {iconForPhase(phase)}
        </span>
        <span className="download-tray-job-album" title={safeAlbumId}>{safeAlbumId}</span>
        <span className="download-tray-phase-badge">{statusLabel}</span>
        {phase === 'Running' && <span className="download-tray-wake-badge">{t('download.tray.screenOnRequired')}</span>}
        {failureCount > 0 && <span className="download-tray-failure-badge">{t('download.tray.failureBadge', { count: failureCount })}</span>}
        <div className="download-tray-job-progress" aria-live="polite">
          <div
            className="download-tray-progressbar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
            aria-label={t('download.tray.progressAria', { percent: percentage })}
          >
            <div className="download-tray-progressbar-fill" style={{ width: `${percentage}%` }} />
          </div>
          <span>{t('download.tray.photoProgress', { done: finishedPhotos, total: totalPhotos })}</span>
        </div>
      </div>
      <div className="download-tray-job-actions">
        {isRunning && (
          <button type="button" className="download-tray-button" aria-label={t('download.tray.pauseJob')} onClick={() => onPause(job.jobId)}>
            {t('download.tray.pause')}
          </button>
        )}
        {isPaused && (
          <button type="button" className="download-tray-button" aria-label={t('download.tray.resumeJob')} onClick={() => onResume(job.jobId)}>
            {t('download.tray.resume')}
          </button>
        )}
        {!isTerminal && (
          <button type="button" className="download-tray-button download-tray-button--danger" aria-label={t('download.tray.cancelJob')} onClick={() => onCancelSoft(job.jobId)}>
            {t('download.tray.cancel')}
          </button>
        )}
        {isTerminal && phase !== 'Done' && (
          <button type="button" className="download-tray-button download-tray-button--danger" aria-label={t('download.tray.discardJob')} onClick={() => onCancelHard(job.jobId)}>
            {t('download.tray.discard')}
          </button>
        )}
      </div>
      {expanded && (
        <div className="download-tray-job-details">
          <dl className="download-tray-counts">
            <div><dt>{t('download.tray.pending')}</dt><dd>{counts.pending}</dd></div>
            <div><dt>{t('download.tray.inflight')}</dt><dd>{counts.inflight}</dd></div>
            <div><dt>{t('download.tray.done')}</dt><dd>{counts.done}</dd></div>
            <div><dt>{t('download.tray.failed')}</dt><dd>{counts.failed}</dd></div>
            <div><dt>{t('download.tray.skipped')}</dt><dd>{counts.skipped}</dd></div>
          </dl>
          {failureCount > 0 && (
            <button type="button" className="download-tray-link-button" onClick={() => onShowFailures?.(job.jobId)}>
              {t('download.tray.showFailures', { count: failureCount })}
            </button>
          )}
          <DownloadFailureList failures={failures} />
        </div>
      )}
    </div>
  );
}

export function shortId(id: string): string {
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function iconForPhase(phase: string): string {
  if (phase === 'Paused') return 'Ⅱ';
  if (phase === 'Done') return '✓';
  if (phase === 'Errored') return '!';
  if (phase === 'Cancelled') return '×';
  return '↓';
}
