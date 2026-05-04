import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

export interface DownloadFailureListEntry {
  /** Short, display-safe photo identifier. Never pass a full photo id. */
  readonly photoIdShort: string;
  /** Stable coordinator error reason code. */
  readonly errorCode: string;
  /** Number of retry attempts already made for this photo. */
  readonly retryCount: number;
  /** Unix timestamp for the most recent attempt. */
  readonly lastAttemptAtMs: number;
}

export interface DownloadFailureListProps {
  /** Failure entries to show. Photo ids must already be shortened by the caller. */
  readonly failures: ReadonlyArray<DownloadFailureListEntry>;
}

/** Inline failure details for a download job, with copy support for user reports. */
export function DownloadFailureList({ failures }: DownloadFailureListProps): JSX.Element | null {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  if (failures.length === 0) {
    return null;
  }

  const copyText = failures
    .map((failure) => `${failure.photoIdShort}\t${failure.errorCode}\t${failure.retryCount}\t${new Date(failure.lastAttemptAtMs).toISOString()}`)
    .join('\n');

  const handleCopy = (): void => {
    if (!navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
    });
  };

  return (
    <div className="download-tray-failures" role="group" aria-label={t('download.tray.failuresTitle')}>
      <div className="download-tray-failures-header">
        <span>{t('download.tray.failuresTitle')}</span>
        <button type="button" className="download-tray-link-button" onClick={handleCopy}>
          {copied ? t('common.copied') : t('download.tray.copyFailures')}
        </button>
      </div>
      <ul className="download-tray-failure-list">
        {failures.map((failure) => (
          <li className="download-tray-failure" key={`${failure.photoIdShort}-${failure.lastAttemptAtMs}`}>
            <span className="download-tray-mono">{failure.photoIdShort}</span>
            <span>{t(`download.errorCode.${failure.errorCode}`, { defaultValue: failure.errorCode })}</span>
            <span>{t('download.tray.retryCount', { count: failure.retryCount })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
