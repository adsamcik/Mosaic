/**
 * Data Export (v1.0.x s38 — GDPR Article 20, right to data portability).
 *
 * Single-button UI that triggers a streaming-zip download of the caller's
 * entire data footprint from `GET /api/v1/export`. The browser owns the
 * download lifecycle — we just navigate an invisible anchor so the response
 * goes through the browser's native download manager (Save-As dialog,
 * progress UI, resume support if the server emits Range headers).
 *
 * Why an anchor + `download` attribute (not `window.fetch`)?
 *   The export can be hundreds of MB to many GB for users with large
 *   libraries. Fetching it into memory in JS just to call URL.createObjectURL
 *   on the resulting Blob would defeat the whole point of the streaming
 *   server-side implementation. Letting the browser handle it streams
 *   straight to disk.
 *
 * The component shows a short explanation, the trigger button, and a
 * non-blocking "this may take a while" notice for the multi-minute case.
 * No progress bar is shown — the browser already renders one, and we have
 * no way to introspect the download from JS once the anchor is clicked.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

const EXPORT_ENDPOINT = '/api/v1/export';

export function DataExport(): React.JSX.Element {
  const { t } = useTranslation();
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownload = useCallback(() => {
    // We deliberately do not use fetch() here — see file header for the
    // streaming/memory rationale. An anchor with the `download` attribute
    // hands the response off to the browser's download manager.
    const anchor = document.createElement('a');
    anchor.href = EXPORT_ENDPOINT;
    // The server sets Content-Disposition with a filename, but we provide
    // an empty download attribute so cross-origin / referrer policies do
    // not strip the disposition hint in some browsers.
    anchor.setAttribute('download', '');
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setIsDownloading(true);
    // The "downloading" state is a UX hint only; the browser owns the
    // actual lifecycle. Clear it after a short delay so the user can
    // trigger another export without reloading the page.
    window.setTimeout(() => setIsDownloading(false), 5000);
  }, []);

  return (
    <section className="settings-section" data-testid="data-export-section">
      <h2 className="section-title">{t('settings.export.title')}</h2>
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">{t('settings.export.heading')}</span>
            <span className="setting-description">
              {t('settings.export.description')}
            </span>
          </div>
          <button
            className="button-primary"
            type="button"
            onClick={handleDownload}
            disabled={isDownloading}
            data-testid="data-export-button"
          >
            {isDownloading
              ? t('settings.export.loadingMessage')
              : t('settings.export.downloadButton')}
          </button>
        </div>
        <div
          className="setting-row settings-notice"
          data-testid="data-export-warning"
        >
          <span className="setting-description">
            {t('settings.export.largeLibraryWarning')}
          </span>
        </div>
      </div>
    </section>
  );
}
