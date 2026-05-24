import { type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useStorageQuota } from '../../hooks/useStorageQuota';
import { formatBytes } from '../../lib/storage-quota';

export interface StoragePressureBannerProps {
  /**
   * Override the pressure threshold (in (0, 1]). Defaults to 0.8 (80%).
   * Exposed mainly to let tests inject a deterministic threshold.
   */
  readonly threshold?: number | undefined;
  /**
   * Disable polling entirely (e.g. in environments where the API is mocked
   * or the banner should never appear). When `true`, the banner is hidden.
   */
  readonly disabled?: boolean | undefined;
}

/**
 * Proactive storage-pressure banner (v1.0.2 storage-pressure-ui).
 *
 * Renders when the browser-reported storage usage crosses the configured
 * threshold (default 80%). The banner offers a single "Dismiss" action
 * that hides the banner for the rest of the session — it will re-appear
 * in the next session if the pressure is still present.
 *
 * The component is purely informational: it never blocks an action or
 * mutates storage. The intent is to give the user enough warning to free
 * space (e.g. by clearing cached albums in Settings) before the browser
 * starts evicting OPFS files or rejecting writes with QuotaExceededError.
 */
export function StoragePressureBanner(
  props: StoragePressureBannerProps = {},
): JSX.Element | null {
  const { t } = useTranslation();
  const { threshold, disabled } = props;
  const { snapshot, underPressure, critical, dismiss } = useStorageQuota({
    threshold,
    disabled,
  });

  if (disabled) return null;
  if (!underPressure) return null;
  if (snapshot === null) return null;

  const usageText = formatBytes(snapshot.usageBytes);
  const quotaText = formatBytes(snapshot.quotaBytes);
  const percent = Math.round(snapshot.usageRatio * 100);

  return (
    <div
      className={
        critical
          ? 'storage-pressure-banner storage-pressure-banner--critical'
          : 'storage-pressure-banner'
      }
      role="status"
      aria-live="polite"
      aria-labelledby="storage-pressure-banner-title"
      data-testid="storage-pressure-banner"
      data-critical={critical ? 'true' : 'false'}
    >
      <div className="storage-pressure-banner-body">
        <h3 id="storage-pressure-banner-title" className="storage-pressure-banner-title">
          {critical
            ? t('storage.pressureBanner.criticalTitle')
            : t('storage.pressureBanner.title')}
        </h3>
        <p className="storage-pressure-banner-message">
          {t('storage.pressureBanner.message', {
            usage: usageText,
            quota: quotaText,
            percent,
          })}
        </p>
      </div>
      <div className="storage-pressure-banner-actions">
        <button
          type="button"
          className="storage-pressure-banner-button"
          onClick={dismiss}
          data-testid="storage-pressure-banner-dismiss"
        >
          {t('storage.pressureBanner.dismiss')}
        </button>
      </div>
    </div>
  );
}
