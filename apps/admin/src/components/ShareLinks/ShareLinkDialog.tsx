/**
 * ShareLinkDialog Component
 *
 * Modal dialog for creating new share links for an album.
 * Handles access tier selection, expiry, max uses, and link generation.
 */

import { useEffect, useRef, useState } from 'react';
import type { AccessTier } from '../../lib/api-types';
import type { CreateShareLinkOptions, CreateShareLinkResult } from '../../hooks/useShareLinks';

interface ShareLinkDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
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
 * ShareLinkDialog Component
 *
 * Provides a modal for:
 * - Selecting access tier (thumbnails, preview, full)
 * - Setting optional expiry date
 * - Setting optional max uses
 * - Generating and displaying the share URL
 */
export function ShareLinkDialog({
  isOpen,
  onClose,
  onCreate,
  isCreating,
  error,
}: ShareLinkDialogProps) {
  const [accessTier, setAccessTier] = useState<AccessTier>(2);
  const [expiryEnabled, setExpiryEnabled] = useState(true);
  const [expiryHours, setExpiryHours] = useState(24 * 7); // Default to 7 days
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(2); // 7 days preset
  const [maxUsesEnabled, setMaxUsesEnabled] = useState(false);
  const [maxUses, setMaxUses] = useState(10);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateShareLinkResult | null>(null);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setAccessTier(2);
      setExpiryEnabled(true);
      setExpiryHours(24 * 7);
      setSelectedPresetIndex(2);
      setMaxUsesEnabled(false);
      setMaxUses(10);
      setLocalError(null);
      setResult(null);
      setCopied(false);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isCreating) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isCreating, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (result) {
      // If we already have a result, just close
      onClose();
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

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isCreating) {
      onClose();
    }
  };

  if (!isOpen) {
    return null;
  }

  const displayError = localError || error;

  // Show result view after successful creation
  if (result) {
    return (
      <div
        className="dialog-backdrop"
        onClick={handleBackdropClick}
        role="presentation"
        data-testid="share-link-dialog-backdrop"
      >
        <dialog
          ref={dialogRef}
          className="dialog"
          open
          aria-labelledby="share-link-title"
          aria-modal="true"
          data-testid="share-link-dialog"
        >
          <div className="dialog-form">
            <h2 id="share-link-title" className="dialog-title">
              Share Link Created
            </h2>

            <p className="dialog-description">
              Your share link has been created. Copy the URL below to share with others.
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
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="share-link-info" data-testid="share-link-info">
              <div className="info-item">
                <span className="info-label">Access:</span>
                <span className="info-value">{result.shareLink.accessTierDisplay}</span>
              </div>
              {result.shareLink.expiryDisplay && (
                <div className="info-item">
                  <span className="info-label">Expires:</span>
                  <span className="info-value">{result.shareLink.expiryDisplay}</span>
                </div>
              )}
              {result.shareLink.maxUses && (
                <div className="info-item">
                  <span className="info-label">Max uses:</span>
                  <span className="info-value">{result.shareLink.maxUses}</span>
                </div>
              )}
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="button-primary"
                onClick={onClose}
                data-testid="done-button"
              >
                Done
              </button>
            </div>
          </div>
        </dialog>
      </div>
    );
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
      data-testid="share-link-dialog-backdrop"
    >
      <dialog
        ref={dialogRef}
        className="dialog"
        open
        aria-labelledby="share-link-title"
        aria-modal="true"
        data-testid="share-link-dialog"
      >
        <form onSubmit={handleSubmit} className="dialog-form">
          <h2 id="share-link-title" className="dialog-title">
            Create Share Link
          </h2>

          <p className="dialog-description">
            Create a shareable link to this album. Anyone with the link can view photos
            at the selected access level.
          </p>

          <div className="form-group">
            <label className="form-label">Access Level</label>
            <div className="tier-selector" data-testid="tier-selector">
              {TIER_OPTIONS.map((option) => (
                <label key={option.value} className="tier-option">
                  <input
                    type="radio"
                    name="accessTier"
                    value={option.value}
                    checked={accessTier === option.value}
                    onChange={() => setAccessTier(option.value)}
                    disabled={isCreating}
                  />
                  <span className="tier-option-label">
                    <strong>{option.label}</strong>
                    <span className="tier-option-description">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Link Expiration</label>
            <div className="expiry-presets" data-testid="expiry-presets">
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
                ⚠️ This link will never expire. Anyone with the link can access 
                the album indefinitely. Consider setting an expiration date.
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
                <span>Maximum</span>
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
                <span>uses</span>
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

          <div className="dialog-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
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
      </dialog>
    </div>
  );
}
