import { useCallback, useEffect, useMemo, useState } from 'react';
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
 * Get today's date formatted for the min attribute (YYYY-MM-DD).
 */
function getMinDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const parts = tomorrow.toISOString().split('T');
  return parts[0] ?? '';
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
 */
export function AlbumExpirationSettings({
  album,
  onUpdate,
}: AlbumExpirationSettingsProps) {
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

  // Reset state when album changes
  useEffect(() => {
    setEnabled(!!album.expiresAt);
    setExpiresAt(formatDateForInput(album.expiresAt));
    setWarningDays(album.expirationWarningDays ?? 7);
    setError(null);
    setSuccess(false);
  }, [album.id, album.expiresAt, album.expirationWarningDays]);

  // Calculate days remaining
  const daysRemaining = useMemo(() => {
    if (!enabled || !expiresAt) return null;
    return calculateDaysRemaining(expiresAt);
  }, [enabled, expiresAt]);

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

  // Save settings
  const handleSave = useCallback(async () => {
    setError(null);
    setSuccess(false);

    // Validate if enabled
    if (enabled && !expiresAt) {
      setError('Please select an expiration date');
      return;
    }

    setSaving(true);

    try {
      const api = getApi();
      const request = enabled
        ? {
            expiresAt: new Date(expiresAt).toISOString(),
            expirationWarningDays: warningDays,
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
          : 'Failed to save expiration settings',
      );
    } finally {
      setSaving(false);
    }
  }, [album.id, enabled, expiresAt, warningDays, onUpdate]);

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
      <h3 className="expiration-settings-title">Album Expiration</h3>
      <p className="text-muted expiration-settings-description">
        Set an expiration date to automatically delete this album and all its
        photos. This action is irreversible once the album expires.
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
        <span>Enable album expiration</span>
      </label>

      {/* Date and Warning Controls - only shown when enabled */}
      {enabled && (
        <div className="expiration-controls" data-testid="expiration-controls">
          {/* Expiration Date */}
          <div className="form-group">
            <label htmlFor="expiration-date" className="form-label">
              Expiration Date
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
            {daysRemaining !== null && !isExpired && (
              <span
                className="expiration-days-remaining"
                data-testid="days-remaining"
              >
                {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining
              </span>
            )}
          </div>

          {/* Warning Banner */}
          {showWarning && (
            <div
              className="warning-banner"
              role="alert"
              data-testid="expiration-warning"
            >
              ⚠️ This album will expire in {daysRemaining}{' '}
              {daysRemaining === 1 ? 'day' : 'days'}. All photos will be
              permanently deleted.
            </div>
          )}

          {/* Expired Banner */}
          {isExpired && (
            <div
              className="error-banner"
              role="alert"
              data-testid="expiration-expired"
            >
              ⚠️ This album has expired and is scheduled for deletion.
            </div>
          )}

          {/* Warning Days */}
          <div className="form-group">
            <label htmlFor="warning-days" className="form-label">
              Warning notification (days before)
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
              Show a warning when the album is within this many days of expiring
            </span>
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
          Settings saved successfully
        </div>
      )}

      {/* Save Button */}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !hasChanges}
        className="button-primary expiration-save-button"
        data-testid="save-expiration-button"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}
