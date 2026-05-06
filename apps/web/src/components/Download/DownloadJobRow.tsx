import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { JobProgressEvent, JobSummary } from '../../workers/types';
import { DownloadFailureList, type DownloadFailureListEntry } from './DownloadFailureList';
import type { JobThumbnail } from '../../hooks/useJobThumbnails';

/**
 * Map raw schedule-evaluation reasons (from ScheduleManager.evaluateSchedule)
 * to i18n keys. Unknown reasons fall back to the raw string so a future
 * Rust-side reason is not silently swallowed.
 *
 * ZK-safety: reasons are GENERIC strings ("connection too slow", "offline")
 * — never job/album/scope ids. Safe to render.
 */
const SCHEDULE_REASON_KEYS: Readonly<Record<string, string>> = {
  'offline': 'download.tray.scheduledReasons.offline',
  'data-saver enabled': 'download.tray.scheduledReasons.dataSaver',
  'connection too slow': 'download.tray.scheduledReasons.connectionTooSlow',
  'not charging': 'download.tray.scheduledReasons.notCharging',
  'user active': 'download.tray.scheduledReasons.userActive',
  'outside window': 'download.tray.scheduledReasons.outsideWindow',
  'window misconfigured': 'download.tray.scheduledReasons.windowMisconfigured',
  'window empty': 'download.tray.scheduledReasons.windowMisconfigured',
};

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
  /**
   * Called when the user clicks Start now on a Scheduled (Idle + schedule)
   * job. Optional — when omitted the action button is hidden.
   */
  readonly onForceStart?: (jobId: string) => void;
  /**
   * Called when the user clicks Edit schedule on a Scheduled job.
   * Optional — when omitted the link is hidden.
   */
  readonly onEditSchedule?: (jobId: string) => void;
  /**
   * In-app preview thumbnails for this job, most-recent first. ZK-safe to
   * render: blob URLs are scoped to the in-page session and ARE NEVER
   * included in any export output (zip / per-file / fsAccessDirectory).
   * When omitted or empty, the strip is collapsed to a hint or hidden.
   */
  readonly thumbnails?: ReadonlyArray<JobThumbnail>;
  /** Maximum thumbnails visible in the strip before "+N more" indicator. Default 8. */
  readonly thumbnailVisibleLimit?: number;
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
  onForceStart,
  onEditSchedule,
  thumbnails = [],
  thumbnailVisibleLimit = 8,
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
  // Visitor-aware terminal copy: a revoked share link is the most common
  // failure for visitor downloads, so surface it explicitly. Auth jobs that
  // fail with AccessRevoked still see the generic "Access revoked" code
  // label via the failure list — they are not visitor-link errors.
  const isShareLinkRevoked = phase === 'Errored'
    && job.lastErrorReason === 'AccessRevoked'
    && job.scopeKey.startsWith('visitor:');
  const isScheduled = phase === 'Idle' && job.schedule !== null && job.schedule.kind !== 'immediate';
  const scheduledReasonLabel = isScheduled && job.scheduleEvaluation
    ? translateScheduleReason(t, job.scheduleEvaluation.reason)
    : null;
  const statusLabel = isShareLinkRevoked
    ? t('download.tray.shareLinkRevoked')
    : isScheduled
      ? t('download.tray.scheduledBadge')
      : t(`download.tray.phase.${phase}`, { defaultValue: phase });
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
        {job.outputModeKind === 'sidecar' && (
          <span className="download-tray-sidecar-badge" data-testid="download-tray-sidecar-badge">
            {t('download.tray.sidecarBadge')}
          </span>
        )}
        {job.scopeKey.startsWith('sidecar:') && (
          <span className="download-tray-sidecar-receiving-badge" data-testid="download-tray-sidecar-receiving-badge">
            {t('download.tray.sidecarReceiving')}
          </span>
        )}
        {phase === 'Running' && <span className="download-tray-wake-badge">{t('download.tray.screenOnRequired')}</span>}
        {failureCount > 0 && <span className="download-tray-failure-badge">{t('download.tray.failureBadge', { count: failureCount })}</span>}
        {isScheduled && scheduledReasonLabel !== null && (
          <span
            className="download-tray-scheduled-reason"
            role="status"
            aria-live="polite"
            data-testid="download-tray-scheduled-reason"
          >
            {t('download.tray.scheduledReason', { reason: scheduledReasonLabel })}
          </span>
        )}
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
        {isScheduled && onForceStart && (
          <button
            type="button"
            className="download-tray-button download-tray-button--primary"
            aria-label={t('download.tray.scheduledStartNow')}
            onClick={() => onForceStart(job.jobId)}
            data-testid="download-tray-start-now"
          >
            {t('download.tray.scheduledStartNow')}
          </button>
        )}
        {isScheduled && onEditSchedule && (
          <button
            type="button"
            className="download-tray-link-button"
            aria-label={t('download.tray.scheduledEdit')}
            onClick={() => onEditSchedule(job.jobId)}
            data-testid="download-tray-edit-schedule"
          >
            {t('download.tray.scheduledEdit')}
          </button>
        )}
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
      <DownloadJobThumbnailStrip thumbnails={thumbnails} visibleLimit={thumbnailVisibleLimit} phase={phase} />
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

/**
 * Horizontal strip of in-app preview thumbnails. Renders nothing when no
 * thumbnails are available and the job is in a "no work happening yet"
 * phase (Idle / Cancelled), otherwise shows a "no previews yet" hint.
 *
 * a11y: respects `prefers-reduced-motion` by omitting any transition
 * styling (none is currently applied; documented for future-proofing).
 *
 * NOT exported: blob URLs are NEVER threaded into any finalizer.
 */
function DownloadJobThumbnailStrip({
  thumbnails,
  visibleLimit,
  phase,
}: {
  readonly thumbnails: ReadonlyArray<JobThumbnail>;
  readonly visibleLimit: number;
  readonly phase: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const visible = thumbnails.slice(0, visibleLimit);
  const overflow = Math.max(0, thumbnails.length - visible.length);
  if (thumbnails.length === 0) {
    if (phase === 'Idle' || phase === 'Cancelled') {
      // Scheduled or cancelled: no work happening — collapse the strip.
      return null;
    }
    return (
      <div className="download-tray-thumbnails download-tray-thumbnails--empty" data-testid="download-tray-thumbnails-empty">
        <span>{t('download.tray.thumbnails.empty')}</span>
      </div>
    );
  }
  return (
    <div
      className="download-tray-thumbnails"
      data-testid="download-tray-thumbnails"
      role="list"
      aria-label={t('download.tray.thumbnails.empty')}
    >
      {visible.map((thumb) => (
        <div key={thumb.photoId} className="download-tray-thumbnail" role="listitem">
          <img
            src={thumb.blobUrl}
            alt=""
            loading="lazy"
            decoding="async"
            width={64}
            height={64}
            onError={(event): void => {
              // Hide the failed image; we keep the slot to avoid layout jump.
              const img = event.currentTarget;
              img.style.visibility = 'hidden';
              img.setAttribute('data-error', 'true');
              img.setAttribute('aria-label', t('download.tray.thumbnails.error'));
            }}
          />
        </div>
      ))}
      {overflow > 0 && (
        <div className="download-tray-thumbnail download-tray-thumbnail--more" data-testid="download-tray-thumbnails-more" role="listitem">
          {t('download.tray.thumbnails.morePhotos', { count: overflow })}
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
  if (phase === 'Idle') return '⏰';
  return '↓';
}

/**
 * Translate a raw {@link ScheduleEvaluation} reason into a user-facing
 * label. Falls back to the raw reason when no mapping exists so future
 * Rust-side strings are surfaced verbatim rather than dropped.
 */
function translateScheduleReason(t: (key: string, opts?: Record<string, unknown>) => string, reason: string): string {
  const key = SCHEDULE_REASON_KEYS[reason];
  if (key === undefined) return reason;
  return t(key);
}
