import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AlbumDownloadProgress } from '../../lib/album-download-service';
import '../../styles/download-progress.css';

interface DownloadProgressOverlayProps {
  progress: AlbumDownloadProgress;
  onCancel: () => void;
}

export function DownloadProgressOverlay({ progress, onCancel }: DownloadProgressOverlayProps) {
  const { t } = useTranslation();
  const isComplete = progress.phase === 'complete';
  const percentage = progress.totalFiles > 0
    ? Math.round((progress.completedFiles / progress.totalFiles) * 100)
    : 0;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isComplete) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, isComplete]);

  useEffect(() => {
    if (isComplete) {
      const timer = setTimeout(onCancel, 2000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, onCancel]);

  return (
    <div className="download-progress-overlay" data-testid="download-progress-overlay">
      <div className={`download-progress-card ${isComplete ? 'download-progress-complete' : ''}`}>
        <div className="download-progress-header">
          <span className={`download-progress-icon ${!isComplete ? 'download-progress-icon--active' : ''}`}>
            {isComplete ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
          </span>
          <h3 className="download-progress-title">
            {isComplete ? t('download.complete') : t('download.title')}
          </h3>
        </div>

        <div className="download-progress-status">
          {progress.phase === 'preparing' && t('download.preparing')}
          {progress.phase === 'downloading' && (
            <>
              {t('download.downloading')}{' '}
              <span className="download-progress-filename">{progress.currentFileName}</span>
            </>
          )}
          {isComplete && t('download.completeMessage', { count: progress.completedFiles })}
        </div>

        <div className="download-progress-bar-container">
          <div
            className="download-progress-bar"
            style={{ width: `${percentage}%` }}
            role="progressbar"
            aria-valuenow={percentage}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>

        <div className="download-progress-count">
          {progress.completedFiles} / {progress.totalFiles}
        </div>

        <div className="download-progress-actions">
          {!isComplete && (
            <button
              className="download-progress-cancel"
              onClick={onCancel}
              data-testid="download-cancel-button"
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
