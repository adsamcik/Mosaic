import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useDownloadManager } from '../../hooks/useDownloadManager';
import type { AlbumDiff, CurrentAlbumManifest, ResumableJobSummary } from '../../workers/types';
import { shortId } from './DownloadJobRow';

export interface DownloadResumePromptProps {
  /** Supplies the caller's freshly decrypted current manifest for a resumable album. */
  readonly getCurrentManifest: (albumId: string) => Promise<CurrentAlbumManifest>;
  /** Optional externally supplied resumable jobs, primarily for tests and host flows. */
  readonly resumableJobs?: ReadonlyArray<ResumableJobSummary>;
  /** Called after a resume request is accepted. Defaults to coordinator resumeJob. */
  readonly onResume?: (jobId: string) => void;
  /** Called after progress is discarded. Defaults to coordinator hard cancel. */
  readonly onDiscard?: (jobId: string) => void;
  /** Controls prompt visibility when the caller wants to defer showing it. */
  readonly open?: boolean;
}

/** Resume sheet for persisted download jobs that can continue after navigation or reload. */
export function DownloadResumePrompt({
  getCurrentManifest,
  resumableJobs,
  onResume,
  onDiscard,
  open = true,
}: DownloadResumePromptProps): JSX.Element | null {
  const { t } = useTranslation();
  const manager = useDownloadManager();
  const jobs = resumableJobs ?? manager.resumableJobs;
  const [diffByJobId, setDiffByJobId] = useState<Record<string, AlbumDiff>>({});
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open || jobs.length === 0) {
    return null;
  }

  const handleResume = (job: ResumableJobSummary): void => {
    setBusyJobId(job.jobId);
    setError(null);
    void getCurrentManifest(job.albumId)
      .then((manifest) => manager.computeAlbumDiff(job.jobId, manifest))
      .then((diff) => {
        setDiffByJobId((current) => ({ ...current, [job.jobId]: diff }));
        if (onResume) {
          onResume(job.jobId);
        } else {
          void manager.resumeJob(job.jobId);
        }
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusyJobId(null));
  };

  const handleDiscard = (jobId: string): void => {
    if (onDiscard) {
      onDiscard(jobId);
      return;
    }
    void manager.cancelJob(jobId, { soft: false });
  };

  return (
    <div className="download-tray-modal-backdrop" role="presentation">
      <section className="download-tray-resume" role="dialog" aria-modal="true" aria-labelledby="download-resume-title">
        <h2 id="download-resume-title">{t('download.tray.resumePromptTitle')}</h2>
        {error && <p className="download-tray-error" role="alert">{error}</p>}
        <ul className="download-tray-resume-list">
          {jobs.map((job) => {
            const diff = diffByJobId[job.jobId];
            return (
              <li className="download-tray-resume-item" key={job.jobId}>
                <div>
                  <strong>{shortId(job.albumId)}</strong>
                  <p>{t('download.tray.resumePromptBody', { done: job.photosDone, total: job.photosTotal })}</p>
                  <p className="download-tray-muted">{formatBytes(job.bytesWritten)}</p>
                </div>
                {diff && <DiffSummary diff={diff} />}
                <div className="download-tray-resume-actions">
                  <button type="button" className="download-tray-button" disabled={busyJobId === job.jobId} onClick={() => handleResume(job)}>
                    {t('download.tray.resume')}
                  </button>
                  <button type="button" className="download-tray-button download-tray-button--danger" onClick={() => handleDiscard(job.jobId)}>
                    {t('download.tray.discard')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function DiffSummary({ diff }: { readonly diff: AlbumDiff }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="download-tray-diff" aria-live="polite">
      <strong>{t('download.diff.title')}</strong>
      <span>{t('download.diff.added', { count: diff.added.length })}</span>
      <span>{t('download.diff.removed', { count: diff.removed.length })}</span>
      <span>{t('download.diff.rekeyed', { count: diff.rekeyed.length })}</span>
      <span>{t('download.diff.shardChanged', { count: diff.shardChanged.length })}</span>
      <span>{t('download.diff.unchanged', { count: diff.unchanged.length })}</span>
    </div>
  );
}


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
