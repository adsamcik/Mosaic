import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Shared/Dialog';

type ExpirationMode = '7d' | '30d' | '90d' | 'custom';

interface CreateAlbumExpirationOptions {
  expiresAt?: string;
  expirationWarningDays?: number;
}

interface CreateAlbumDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Called to create an album */
  onCreate: (name: string, options?: CreateAlbumExpirationOptions) => Promise<void>;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** Error message to display */
  error: string | null;
}

const PRESET_DAYS: Record<Exclude<ExpirationMode, 'custom'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function computeExpirationDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function getMinDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

function formatDate(isoString: string, locale: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Create Album Dialog Component
 *
 * Modal dialog for creating a new album with encrypted name.
 * Supports optional expiration for temporary albums.
 * Handles form state, validation, and accessibility.
 */
export function CreateAlbumDialog({
  isOpen,
  onClose,
  onCreate,
  isCreating,
  error,
}: CreateAlbumDialogProps) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [showExpiration, setShowExpiration] = useState(false);
  const [expirationMode, setExpirationMode] = useState<ExpirationMode>('7d');
  const [customDate, setCustomDate] = useState('');
  const [expirationConfirmed, setExpirationConfirmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Compute the expiration ISO string based on current mode
  const expiresAt = useMemo(() => {
    if (!showExpiration) return undefined;
    if (expirationMode === 'custom') {
      if (!customDate) return undefined;
      // Custom date is YYYY-MM-DD; set to end of day in local timezone
      const date = new Date(customDate + 'T23:59:59');
      return date.toISOString();
    }
    return computeExpirationDate(PRESET_DAYS[expirationMode]);
  }, [showExpiration, expirationMode, customDate]);

  // Human-readable preview of expiration date
  const expirationPreview = useMemo(() => {
    if (!expiresAt) return null;
    return formatDate(expiresAt, i18n.language);
  }, [expiresAt, i18n.language]);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setName('');
      setLocalError(null);
      setShowExpiration(false);
      setExpirationMode('7d');
      setCustomDate('');
      setExpirationConfirmed(false);
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

    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError(t('album.create.error.nameRequired'));
      return;
    }

    if (trimmedName.length > 100) {
      setLocalError(t('album.create.error.nameTooLong'));
      return;
    }

    if (showExpiration && !expirationConfirmed) {
      setLocalError(t('album.create.error.expirationAcknowledgementRequired'));
      return;
    }

    setLocalError(null);

    const options: CreateAlbumExpirationOptions | undefined =
      showExpiration && expiresAt
        ? { expiresAt, expirationWarningDays: 7 }
        : undefined;

    try {
      await onCreate(trimmedName, options);
    } catch {
      // Error is handled by parent via error prop
    }
  };

  if (!isOpen) {
    return null;
  }

  const displayError = localError || error;

  const footer = (
    <>
      <button
        type="button"
        onClick={onClose}
        disabled={isCreating}
        className="button-secondary"
        data-testid="cancel-button"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        form="create-album-form"
        disabled={
          isCreating ||
          !name.trim() ||
          (showExpiration && (!expiresAt || !expirationConfirmed))
        }
        className="button-primary"
        data-testid="create-button"
      >
        {isCreating ? t('album.create.creating') : t('album.create.submit')}
      </button>
    </>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('album.create.title')}
      description={t('album.create.description')}
      footer={footer}
      testId="create-album-dialog"
      closeOnBackdropClick={!isCreating}
    >
      <form
        onSubmit={handleSubmit}
        className="dialog-form"
        id="create-album-form"
      >
        <div className="form-group">
          <label htmlFor="album-name" className="form-label">
            {t('album.create.nameLabel')}
          </label>
          <input
            ref={inputRef}
            id="album-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('album.create.namePlaceholder')}
            disabled={isCreating}
            className="form-input"
            autoComplete="off"
            maxLength={100}
            aria-describedby={displayError ? 'album-error' : undefined}
            data-testid="album-name-input"
          />
        </div>

        {/* Temporary album expiration section */}
        <div className="expiration-section">
          <button
            type="button"
            className="expiration-toggle"
            onClick={() => {
              const next = !showExpiration;
              setShowExpiration(next);
              if (!next) {
                setExpirationConfirmed(false);
              }
            }}
            aria-expanded={showExpiration}
            disabled={isCreating}
            data-testid="expiration-toggle"
          >
            <span className={`expiration-toggle-icon ${showExpiration ? 'expanded' : ''}`}>
              ▶
            </span>
            {t('album.create.temporaryAlbum')}
          </button>

          {showExpiration && (
            <div className="expiration-content" data-testid="expiration-content">
              <div className="expiration-warning" role="alert">
                ⚠️ {t('album.create.temporaryWarning')}
              </div>

              <label
                className="checkbox-row expiration-confirmation"
                data-testid="expiration-confirmation-row"
              >
                <input
                  type="checkbox"
                  checked={expirationConfirmed}
                  onChange={(e) => {
                    setExpirationConfirmed(e.target.checked);
                    setLocalError(null);
                  }}
                  disabled={isCreating}
                  data-testid="expiration-confirm-checkbox"
                />
                <span>{t('album.create.expirationAcknowledge')}</span>
              </label>

              <div className="form-group">
                <label className="form-label">{t('album.create.duration')}</label>
                <div className="expiration-presets" role="group" aria-label={t('album.create.duration')}>
                  {(['7d', '30d', '90d', 'custom'] as ExpirationMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`expiration-preset-btn ${expirationMode === mode ? 'active' : ''}`}
                      onClick={() => setExpirationMode(mode)}
                      disabled={isCreating}
                      data-testid={`expiration-${mode}`}
                    >
                      {mode === 'custom'
                        ? t('album.create.custom')
                        : t(`album.create.days_${PRESET_DAYS[mode as Exclude<ExpirationMode, 'custom'>]}`)}
                    </button>
                  ))}
                </div>
              </div>

              {expirationMode === 'custom' && (
                <div className="form-group">
                  <label htmlFor="expiration-date" className="form-label">
                    {t('album.create.expirationDate')}
                  </label>
                  <input
                    id="expiration-date"
                    type="date"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                    min={getMinDate()}
                    disabled={isCreating}
                    className="form-input"
                    data-testid="expiration-date-input"
                  />
                </div>
              )}

              {expirationPreview && (
                <div className="expiration-preview" data-testid="expiration-preview">
                  {t('album.create.expiresOn', { date: expirationPreview })}
                </div>
              )}
            </div>
          )}
        </div>

        {displayError && (
          <div
            id="album-error"
            className="form-error"
            role="alert"
            data-testid="create-album-error"
          >
            {displayError}
          </div>
        )}
      </form>
    </Dialog>
  );
}
