/**
 * CreateShareLinkView Component
 *
 * View for creating new share links for an album.
 * Handles access tier selection, expiry, max uses, and link generation.
 * Designed to be rendered within the ShareLinksPanel.
 */

import { useRef, useState } from 'react';
import type {
  CreateShareLinkOptions,
  CreateShareLinkResult,
} from '../../hooks/useShareLinks';
import type { AccessTier } from '../../lib/api-types';

interface CreateShareLinkViewProps {
  /** Called when creation is cancelled */
  onCancel: () => void;
  /** Called when creation is done (after success) */
  onDone: () => void;
  /** Called to create a share link */
  onCreate: (options: CreateShareLinkOptions) => Promise<CreateShareLinkResult>;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** Error message to display */
  error: string | null;
}

/** Access tier option */
interface TierOption {
  value: AccessTier;
  label: string;
  description: string;
}

/** Expiry preset option */
export interface ExpiryPreset {
  label: string;
  hours: number | null;
}

/** Expiry presets for quick selection */
export const EXPIRY_PRESETS: ExpiryPreset[] = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '1 year', hours: 24 * 365 },
  { label: 'Never', hours: null },
];

const TIER_OPTIONS: TierOption[] = [
  {
    value: 1,
    label: 'Thumbnails Only',
    description: 'Low resolution thumbnails (300px)',
  },
  {
    value: 2,
    label: 'Preview',
    description: 'Medium resolution previews (1200px)',
  },
  {
    value: 3,
    label: 'Full Access',
    description: 'Original full resolution photos',
  },
];

/**
 * CreateShareLinkView Component
 */
export function CreateShareLinkView({
  onCancel,
  onDone,
  onCreate,
  isCreating,
  error,
}: CreateShareLinkViewProps) {
  const [accessTier, setAccessTier] = useState<AccessTier>(2);
  const [expiryEnabled, setExpiryEnabled] = useState(true);
  const [expiryHours, setExpiryHours] = useState(24 * 7); // Default to 7 days
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(2); // 7 days preset
  const [maxUsesEnabled, setMaxUsesEnabled] = useState(false);
  const [maxUses, setMaxUses] = useState(10);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateShareLinkResult | null>(null);
  const [copied, setCopied] = useState(false);

  const urlInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (result) {
      // If we already have a result, just close
      onDone();
      return;
    }

    setLocalError(null);

    // Validate inputs
    if (maxUsesEnabled && maxUses < 1) {
      setLocalError('Max uses must be at least 1');
      return;
    }

    try {
      const options: CreateShareLinkOptions = {
        accessTier,
      };

      if (expiryEnabled && expiryHours !== null) {
        const expiresAt = new Date();
        expiresAt.setTime(expiresAt.getTime() + expiryHours * 60 * 60 * 1000);
        options.expiresAt = expiresAt;
      }

      if (maxUsesEnabled) {
        options.maxUses = maxUses;
      }

      const linkResult = await onCreate(options);
      setResult(linkResult);
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

  const handleCopyLink = async () => {
    if (!result) return;

    try {
      await navigator.clipboard.writeText(result.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Fallback: select the input text
      urlInputRef.current?.select();
      setLocalError('Press Ctrl+C to copy');
    }
  };

  const displayError = localError || error;

  // Show result view after successful creation
  if (result) {
    return (
      <div
        className="panel-content-view"
        data-testid="create-share-link-success"
      >
        <div className="share-link-success-header">
          <div className="success-icon-circle">✓</div>
          <h3>Link Created</h3>
        </div>

        <p className="panel-description">
          Copy the URL below to share with others.
        </p>

        <div className="form-group">
          <label htmlFor="share-url" className="form-label">
            Share URL
          </label>
          <div className="input-with-button">
            <input
              ref={urlInputRef}
              id="share-url"
              type="text"
              value={result.shareUrl}
              readOnly
              className="form-input share-url-input"
              onClick={(e) => (e.target as HTMLInputElement).select()}
              data-testid="share-url-input"
            />
            <button
              type="button"
              className="button-primary copy-button"
              onClick={handleCopyLink}
              data-testid="copy-link-button"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="share-link-info-card" data-testid="share-link-info">
          <div className="info-item">
            <span className="info-label">Access</span>
            <span className="info-value">
              {result.shareLink.accessTierDisplay}
            </span>
          </div>
          {result.shareLink.expiryDisplay && (
            <div className="info-item">
              <span className="info-label">Expires</span>
              <span className="info-value">
                {result.shareLink.expiryDisplay}
              </span>
            </div>
          )}
          {result.shareLink.maxUses && (
            <div className="info-item">
              <span className="info-label">Max uses</span>
              <span className="info-value">{result.shareLink.maxUses}</span>
            </div>
          )}
        </div>

        <div className="panel-actions">
          <button
            type="button"
            className="button-primary full-width"
            onClick={onDone}
            data-testid="done-button"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-content-view" data-testid="create-share-link-view">
      <form onSubmit={handleSubmit} className="panel-form">
        <p className="panel-description">
          Anyone with the link can view photos at the selected access level.
        </p>

        <div className="form-group">
          <label className="form-label">Access Level</label>
          <div className="tier-selector vertical" data-testid="tier-selector">
            {TIER_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`tier-option ${accessTier === option.value ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="accessTier"
                  value={option.value}
                  checked={accessTier === option.value}
                  onChange={() => setAccessTier(option.value)}
                  disabled={isCreating}
                />
                <div className="tier-option-content">
                  <span className="tier-option-label">{option.label}</span>
                  <span className="tier-option-description">
                    {option.description}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Link Expiration</label>
          <div className="expiry-presets grid-3" data-testid="expiry-presets">
            {EXPIRY_PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                type="button"
                className={`expiry-preset-button ${selectedPresetIndex === index ? 'selected' : ''}`}
                onClick={() => handlePresetClick(preset, index)}
                disabled={isCreating}
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
              disabled={isCreating}
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
                disabled={isCreating}
                className="form-input number-input"
                data-testid="max-uses-input"
              />
              <span>uses maximum</span>
            </div>
          )}
        </div>

        {displayError && (
          <div
            id="share-link-error"
            className="form-error"
            role="alert"
            data-testid="share-link-error"
          >
            {displayError}
          </div>
        )}

        <div className="panel-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={onCancel}
            disabled={isCreating}
            data-testid="cancel-button"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button-primary"
            disabled={isCreating}
            data-testid="generate-button"
          >
            {isCreating ? 'Generating...' : 'Generate Link'}
          </button>
        </div>
      </form>
    </div>
  );
}
