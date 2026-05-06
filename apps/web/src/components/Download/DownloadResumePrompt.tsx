import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useDownloadManager } from '../../hooks/useDownloadManager';
import type { AlbumDiff, CurrentAlbumManifest, DownloadOutputMode, PhotoMeta, ResumableJobSummary } from '../../workers/types';
import { DownloadModePicker } from './DownloadModePicker';
import { shortId } from './DownloadJobRow';

export interface DownloadResumePromptProps {
  /** Supplies the caller's freshly decrypted current manifest for a resumable album. */
  readonly getCurrentManifest: (albumId: string) => Promise<CurrentAlbumManifest>;
  /** Optional externally supplied resumable jobs, primarily for tests and host flows. */
  readonly resumableJobs?: ReadonlyArray<ResumableJobSummary>;
  /**
   * Called after the user picks a mode and confirms resume. Defaults to
   * coordinator resumeJob({ mode }), which is required because reconstructed
   * jobs lose their in-memory output mode on restart and must be re-prompted.
   */
  readonly onResume?: (jobId: string, mode: DownloadOutputMode) => void;
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
  /** When non-null, render the mode-picker step for this resumable job. */
  const [pickerJobId, setPickerJobId] = useState<string | null>(null);

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
        // Open the mode-picker step. Final resume is dispatched in handlePickerConfirm.
        setPickerJobId(job.jobId);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusyJobId(null));
  };

  const handlePickerConfirm = (jobId: string, mode: DownloadOutputMode): void => {
    setPickerJobId(null);
    if (onResume) {
      onResume(jobId, mode);
    } else {
      void manager.resumeJob(jobId, { mode }).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    }
  };

  const handlePickerCancel = (): void => {
    setPickerJobId(null);
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
      {pickerJobId !== null && (() => {
        const job = jobs.find((candidate) => candidate.jobId === pickerJobId);
        if (!job) return null;
        return (
          <DownloadModePicker
            open
            albumId={job.albumId}
            suggestedFileName={shortId(job.albumId)}
            // No PhotoMeta available at this layer; the picker only uses
            // the array length for capability hints, so an empty array is
            // acceptable here.
            photos={[] as ReadonlyArray<PhotoMeta>}
            onConfirm={(mode) => handlePickerConfirm(job.jobId, mode)}
            onClose={handlePickerCancel}
          />
        );
      })()}
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
