import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApi } from '../../lib/api';
import type { Album } from '../../lib/api-types';

interface AlbumExpirationSettingsProps {
  /** The album to configure expiration for */
  album: Album;
  /** Called when expiration settings are successfully updated */
  onUpdate: () => void;
}

/**
 * Calculate days remaining until a date.
 * Returns null if no date provided.
 */
function calculateDaysRemaining(
  expiresAt: string | null | undefined,
): number | null {
  if (!expiresAt) return null;

  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  return diffDays;
}

/**
 * Format a date for the date input (YYYY-MM-DD).
 */
function formatDateForInput(dateStr: string | null | undefined): string {
  if (!dateStr) return '';

  try {
    const date = new Date(dateStr);
    // Format as YYYY-MM-DD for date input
    const parts = date.toISOString().split('T');
    return parts[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Format a date string into a localized human-readable format.
 */
function formatDateForDisplay(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Get today's date formatted for the min attribute (YYYY-MM-DD).
 */
function getMinDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const parts = tomorrow.toISOString().split('T');
  return parts[0] ?? '';
}

/**
 * Determine whether a save requires confirmation.
 * Confirmation is needed when enabling expiration or moving the date earlier.
 */
function needsConfirmation(
  enabled: boolean,
  expiresAt: string,
  originalEnabled: boolean,
  originalDate: string,
): boolean {
  // Disabling expiration — no confirmation needed
  if (!enabled) return false;

  // Enabling expiration for the first time
  if (!originalEnabled && enabled) return true;

  // Date changed to earlier than the original
  if (expiresAt && originalDate && expiresAt < originalDate) return true;

  // Date set when there was none before
  if (expiresAt && !originalDate) return true;

  return false;
}

/**
 * Album Expiration Settings Component
 *
 * Allows album owners to configure album expiration settings:
 * - Enable/disable expiration
 * - Set expiration date
 * - Configure warning notification days
 *
 * Shows warning banner when album expires within 7 days.
 * Requires confirmation when enabling expiration or moving date earlier.
 * Auto-clamps warning days to album lifetime.
 */
export function AlbumExpirationSettings({
  album,
  onUpdate,
}: AlbumExpirationSettingsProps) {
  const { t } = useTranslation();

  // State
  const [enabled, setEnabled] = useState(!!album.expiresAt);
  const [expiresAt, setExpiresAt] = useState(
    formatDateForInput(album.expiresAt),
  );
  const [warningDays, setWarningDays] = useState(
    album.expirationWarningDays ?? 7,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  // Reset state when album changes
  useEffect(() => {
    setEnabled(!!album.expiresAt);
    setExpiresAt(formatDateForInput(album.expiresAt));
    setWarningDays(album.expirationWarningDays ?? 7);
    setError(null);
    setSuccess(false);
    setShowConfirmation(false);
  }, [album.id, album.expiresAt, album.expirationWarningDays]);

  // Calculate days remaining
  const daysRemaining = useMemo(() => {
    if (!enabled || !expiresAt) return null;
    return calculateDaysRemaining(expiresAt);
  }, [enabled, expiresAt]);

  // Auto-clamp warning days when they exceed days remaining
  const warningDaysClamped = useMemo(() => {
    if (daysRemaining === null || daysRemaining <= 0) return false;
    return warningDays >= daysRemaining;
  }, [daysRemaining, warningDays]);

  const effectiveWarningDays = useMemo(() => {
    if (daysRemaining === null || daysRemaining <= 0) return warningDays;
    if (warningDays >= daysRemaining) {
      return Math.max(1, daysRemaining - 1);
    }
    return warningDays;
  }, [daysRemaining, warningDays]);

  // Check if warning should be shown (7 days or less)
  const showWarning =
    daysRemaining !== null && daysRemaining <= 7 && daysRemaining > 0;
  const isExpired = daysRemaining !== null && daysRemaining <= 0;

  // Handle enable/disable toggle
  const handleEnabledChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setEnabled(e.target.checked);
      setError(null);
      setSuccess(false);
      setShowConfirmation(false);

      // If enabling and no date set, default to 30 days from now
      if (e.target.checked && !expiresAt) {
        const defaultDate = new Date();
        defaultDate.setDate(defaultDate.getDate() + 30);
        const parts = defaultDate.toISOString().split('T');
        setExpiresAt(parts[0] ?? '');
      }
    },
    [expiresAt],
  );

  // Handle date change
  const handleDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setExpiresAt(e.target.value);
      setError(null);
      setSuccess(false);
      setShowConfirmation(false);
    },
    [],
  );

  // Handle warning days change
  const handleWarningDaysChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value) && value >= 1 && value <= 30) {
        setWarningDays(value);
        setError(null);
        setSuccess(false);
      }
    },
    [],
  );

  // Perform the actual save to the API
  const performSave = useCallback(async () => {
    setSaving(true);
    setShowConfirmation(false);

    try {
      const api = getApi();
      const request = enabled
        ? {
            expiresAt: new Date(expiresAt).toISOString(),
            expirationWarningDays: effectiveWarningDays,
          }
        : { expiresAt: null };
      await api.updateAlbumExpiration(album.id, request);

      setSuccess(true);
      onUpdate();

      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('album.expiration.error.saveFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, [album.id, enabled, expiresAt, effectiveWarningDays, onUpdate, t]);

  // Handle save button click — may show confirmation first
  const handleSave = useCallback(() => {
    setError(null);
    setSuccess(false);

    // Validate if enabled
    if (enabled && !expiresAt) {
      setError(t('album.expiration.error.dateRequired'));
      return;
    }

    const originalEnabled = !!album.expiresAt;
    const originalDate = formatDateForInput(album.expiresAt);

    if (needsConfirmation(enabled, expiresAt, originalEnabled, originalDate)) {
      setShowConfirmation(true);
    } else {
      void performSave();
    }
  }, [album.expiresAt, enabled, expiresAt, performSave, t]);

  // Handle confirmation cancel
  const handleCancelConfirmation = useCallback(() => {
    setShowConfirmation(false);
  }, []);

  // Handle confirmation confirm
  const handleConfirm = useCallback(() => {
    void performSave();
  }, [performSave]);

  // Check if settings have changed
  const hasChanges = useMemo(() => {
    const originalEnabled = !!album.expiresAt;
    const originalDate = formatDateForInput(album.expiresAt);
    const originalWarningDays = album.expirationWarningDays ?? 7;

    if (enabled !== originalEnabled) return true;
    if (enabled && expiresAt !== originalDate) return true;
    if (enabled && warningDays !== originalWarningDays) return true;

    return false;
  }, [
    album.expiresAt,
    album.expirationWarningDays,
    enabled,
    expiresAt,
    warningDays,
  ]);

  return (
    <div className="expiration-settings" data-testid="expiration-settings">
      <h3 className="expiration-settings-title">{t('album.expiration.title')}</h3>
      <p className="text-muted expiration-settings-description">
        {t('album.expiration.description')}
      </p>

      {/* Enable/Disable Toggle */}
      <label className="checkbox-row" data-testid="expiration-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={handleEnabledChange}
          disabled={saving}
          data-testid="expiration-enabled-checkbox"
        />
        <span>{t('album.expiration.enableLabel')}</span>
      </label>

      {/* Date and Warning Controls - only shown when enabled */}
      {enabled && (
        <div className="expiration-controls" data-testid="expiration-controls">
          {/* Expiration Date */}
          <div className="form-group">
            <label htmlFor="expiration-date" className="form-label">
              {t('album.expiration.expirationDateLabel')}
            </label>
            <input
              id="expiration-date"
              type="date"
              min={getMinDate()}
              value={expiresAt}
              onChange={handleDateChange}
              disabled={saving}
              className="form-input"
              data-testid="expiration-date-input"
            />
          </div>

          {/* Days Remaining Info Box */}
          {daysRemaining !== null && !isExpired && (
            <div
              className="info-banner expiration-days-info"
              data-testid="days-remaining"
            >
              <strong>{formatDateForDisplay(expiresAt)}</strong>
              {' — '}
              {t('album.expiration.daysRemaining', { days: daysRemaining, count: daysRemaining ?? 0 })}
            </div>
          )}

          {/* Warning Banner */}
          {showWarning && (
            <div
              className="warning-banner"
              role="alert"
              data-testid="expiration-warning"
            >
              {daysRemaining === 1
                ? t('album.expiration.warningDaysSingular', { days: daysRemaining })
                : t('album.expiration.warningDaysPlural', { days: daysRemaining })}
            </div>
          )}

          {/* Expired Banner */}
          {isExpired && (
            <div
              className="error-banner"
              role="alert"
              data-testid="expiration-expired"
            >
              {t('album.expiration.expiredWarning')}
            </div>
          )}

          {/* Warning Days */}
          <div className="form-group">
            <label htmlFor="warning-days" className="form-label">
              {t('album.expiration.warningDaysLabel')}
            </label>
            <input
              id="warning-days"
              type="number"
              min={1}
              max={30}
              value={warningDays}
              onChange={handleWarningDaysChange}
              disabled={saving}
              className="form-input warning-days-input"
              data-testid="warning-days-input"
            />
            <span className="setting-description">
              {t('album.expiration.warningDaysHint')}
            </span>
            {warningDaysClamped && (
              <div
                className="warning-banner warning-days-clamped"
                role="status"
                data-testid="warning-days-clamped"
              >
                {t('album.expiration.warningDaysClamped')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="form-error" role="alert" data-testid="expiration-error">
          {error}
        </div>
      )}

      {/* Success Message */}
      {success && (
        <div
          className="form-success"
          role="status"
          data-testid="expiration-success"
        >
          {t('common.settingsSaved')}
        </div>
      )}

      {/* Confirmation Section */}
      {showConfirmation && (
        <div
          className="confirmation-banner"
          role="alert"
          data-testid="expiration-confirmation"
        >
          <strong>{t('album.expiration.confirmTitle')}</strong>
          <p>
            {t('album.expiration.confirmMessage', {
              date: formatDateForDisplay(expiresAt),
            })}
          </p>
          <p>{t('album.expiration.confirmServerEnforced')}</p>
          <div className="confirmation-actions">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={saving}
              className="button-danger"
              data-testid="confirm-expiration-button"
            >
              {saving ? t('common.saving') : t('album.expiration.confirm')}
            </button>
            <button
              type="button"
              onClick={handleCancelConfirmation}
              disabled={saving}
              className="button-secondary"
              data-testid="cancel-expiration-button"
            >
              {t('album.expiration.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Save Button — hidden when confirmation is showing */}
      {!showConfirmation && (
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="button-primary expiration-save-button"
          data-testid="save-expiration-button"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      )}
    </div>
  );
}
