/**
 * EditShareLinkView Component
 *
 * View for editing expiration settings of an existing share link.
 * Allows updating expiresAt and maxUses for a link.
 * Designed to be rendered within the ShareLinksPanel.
 */

import { useState } from 'react';
import type { ShareLinkInfo } from '../../hooks/useShareLinks';
import { EXPIRY_PRESETS, type ExpiryPreset } from './ShareLinkDialog';

export interface EditShareLinkViewProps {
  /** The share link to edit */
  link: ShareLinkInfo;
  /** Album ID the link belongs to */
  albumId: string;
  /** Called when save is complete */
  onSave: () => void;
  /** Called when editing is cancelled */
  onCancel: () => void;
  /** Called to update the link expiration */
  onUpdate: (
    linkId: string,
    expiresAt: Date | null,
    maxUses: number | null
  ) => Promise<void>;
  /** Whether update is in progress */
  isUpdating: boolean;
  /** Error message to display */
  error: string | null;
}

/**
 * Calculate initial preset index based on link's current expiration
 */
function getInitialPresetIndex(expiresAt: string | undefined | null): number {
  if (!expiresAt) {
    // "Never" preset
    return EXPIRY_PRESETS.length - 1;
  }
  // Default to custom (no preset selected)
  return -1;
}

/**
 * Calculate remaining hours until expiration
 */
function getRemainingHours(expiresAt: string | undefined | null): number {
  if (!expiresAt) {
    return 0;
  }
  const expiresDate = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiresDate.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60)));
}

/**
 * EditShareLinkView Component
 */
export function EditShareLinkView({
  link,
  onSave,
  onCancel,
  onUpdate,
  isUpdating,
  error,
}: EditShareLinkViewProps) {
  const [expiryEnabled, setExpiryEnabled] = useState(!!link.expiresAt);
  const [expiryHours, setExpiryHours] = useState(() => getRemainingHours(link.expiresAt));
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(() =>
    getInitialPresetIndex(link.expiresAt)
  );
  const [maxUsesEnabled, setMaxUsesEnabled] = useState(link.maxUses !== undefined && link.maxUses !== null);
  const [maxUses, setMaxUses] = useState(link.maxUses ?? 10);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLocalError(null);

    // Validate inputs
    if (maxUsesEnabled && maxUses < 1) {
      setLocalError('Max uses must be at least 1');
      return;
    }

    try {
      let expiresAt: Date | null = null;

      if (expiryEnabled && expiryHours > 0) {
        expiresAt = new Date();
        expiresAt.setTime(expiresAt.getTime() + expiryHours * 60 * 60 * 1000);
      }

      const maxUsesValue = maxUsesEnabled ? maxUses : null;

      await onUpdate(link.id, expiresAt, maxUsesValue);
      onSave();
    } catch {
      // Error is handled via error prop
    }
  };

  const handlePresetClick = (preset: ExpiryPreset, index: number) => {
    setSelectedPresetIndex(index);
    if (preset.hours === null) {
      setExpiryEnabled(false);
      setExpiryHours(0);
    } else {
      setExpiryEnabled(true);
      setExpiryHours(preset.hours);
    }
  };

  const displayError = localError || error;

  return (
    <div className="panel-content-view" data-testid="edit-share-link-view">
      <form onSubmit={handleSubmit} className="panel-form">
        <p className="panel-description">
          Update the expiration settings for this share link.
        </p>

        <div className="share-link-info-card" data-testid="edit-link-info">
          <div className="info-item">
            <span className="info-label">Access</span>
            <span className="info-value">{link.accessTierDisplay}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Uses</span>
            <span className="info-value">
              {link.useCount}
              {link.maxUses !== undefined && ` / ${link.maxUses}`}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">Created</span>
            <span className="info-value">
              {new Date(link.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
          </div>
          {link.expiryDisplay && (
            <div className="info-item">
              <span className="info-label">Current expiry</span>
              <span className="info-value">{link.expiryDisplay}</span>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">New Expiration</label>
          <div className="expiry-presets grid-3" data-testid="expiry-presets">
            {EXPIRY_PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                type="button"
                className={`expiry-preset-button ${selectedPresetIndex === index ? 'selected' : ''}`}
                onClick={() => handlePresetClick(preset, index)}
                disabled={isUpdating}
                data-testid={`expiry-preset-${preset.label.toLowerCase().replace(/\s/g, '-')}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {!expiryEnabled && (
            <div className="warning-banner" data-testid="never-expires-warning">
              ⚠️ Link will never expire.
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label checkbox-label">
            <input
              type="checkbox"
              checked={maxUsesEnabled}
              onChange={(e) => setMaxUsesEnabled(e.target.checked)}
              disabled={isUpdating}
              data-testid="max-uses-checkbox"
            />
            <span>Limit number of uses</span>
          </label>
          {maxUsesEnabled && (
            <div className="max-uses-input" data-testid="max-uses-input-group">
              <input
                type="number"
                min={1}
                max={1000}
                value={maxUses}
                onChange={(e) => setMaxUses(parseInt(e.target.value, 10) || 1)}
                disabled={isUpdating}
                className="form-input number-input"
                data-testid="max-uses-input"
              />
              <span>uses maximum</span>
            </div>
          )}
        </div>

        {displayError && (
          <div
            id="edit-link-error"
            className="form-error"
            role="alert"
            data-testid="edit-link-error"
          >
            {displayError}
          </div>
        )}

        <div className="panel-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={onCancel}
            disabled={isUpdating}
            data-testid="cancel-button"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button-primary"
            disabled={isUpdating}
            data-testid="save-button"
          >
            {isUpdating ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

