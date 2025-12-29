import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useAlbumCover } from '../../hooks/useAlbumCover';

/** Badge type for expiration status */
interface ExpirationBadge {
  text: string;
  variant: 'warning' | 'danger' | 'info';
}

/** Album data with optional encrypted name fields */
interface Album {
  id: string;
  /** Displayed album name (either decrypted or placeholder) */
  name: string;
  /** Number of photos in the album */
  photoCount: number;
  /** ISO timestamp when album was created */
  createdAt: string;
  /** Base64-encoded encrypted name from server (optional) */
  encryptedName?: string | null;
  /** Decrypted name (populated after decryption) */
  decryptedName?: string | null;
  /** Whether the name is currently being decrypted */
  isDecrypting?: boolean;
  /** Whether decryption failed */
  decryptionFailed?: boolean;
  /** ISO 8601 date when album expires */
  expiresAt?: string | null;
  /** Base64-encoded encrypted description from server (optional) */
  encryptedDescription?: string | null;
  /** Decrypted description (populated after decryption) */
  decryptedDescription?: string | null;
}

interface AlbumCardProps {
  album: Album;
  onClick: () => void;
}

/**
 * Get the display name for an album.
 * Prioritizes: decryptedName > name > placeholder
 */
function getDisplayName(album: Album): string {
  if (album.decryptedName) {
    return album.decryptedName;
  }
  return album.name;
}

/**
 * Calculate expiration badge based on days remaining.
 * Returns null if no expiration is set.
 */
export function formatExpirationBadge(
  expiresAt: string | null | undefined,
  t: TFunction
): ExpirationBadge | null {
  if (!expiresAt) return null;

  const days = Math.ceil(
    (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  if (days <= 0) return { text: t('album.expired'), variant: 'danger' };
  if (days === 1) return { text: t('album.expiresInDay'), variant: 'warning' };
  if (days <= 7) return { text: t('album.expiresIn', { days }), variant: 'warning' };
  if (days <= 30) {
    const weeks = Math.ceil(days / 7);
    return { text: t('album.expiresInWeeks', { weeks }), variant: 'info' };
  }
  const months = Math.ceil(days / 30);
  return {
    text: t('album.expiresInMonths', { months }),
    variant: 'info',
  };
}

/**
 * Album Card Component
 * Displays a single album in the list with decrypted name support.
 *
 * Shows:
 * - Cover thumbnail when available
 * - Loading indicator while fetching
 * - Decrypted name when available
 * - Placeholder name on error
 */
export function AlbumCard({ album, onClick }: AlbumCardProps) {
  const { t } = useTranslation();
  const displayName = getDisplayName(album);
  const isLoading = album.isDecrypting;
  const hasError = album.decryptionFailed;

  // Fetch album cover thumbnail
  const {
    coverUrl,
    isLoading: isCoverLoading,
    error: coverError,
  } = useAlbumCover(album.id);

  return (
    <button className="album-card" onClick={onClick} data-testid="album-card">
      <div className="album-cover" data-testid="album-cover">
        {isCoverLoading ? (
          <div className="album-cover-loading" data-testid="album-cover-loading">
            <div className="cover-spinner" />
          </div>
        ) : coverUrl ? (
          <img
            src={coverUrl}
            alt={displayName}
            className="album-cover-image"
            data-testid="album-cover-image"
          />
        ) : (
          <span
            className="album-icon"
            data-testid="album-icon"
            title={coverError ? t('album.coverError') : t('album.noCover')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </span>
        )}
      </div>
      <div className="album-info">
        <h3 className="album-name" data-testid="album-name">
          {isLoading ? (
            <span className="album-name-loading" data-testid="album-name-loading">
              <span className="loading-dots">{t('common.loadingDots')}</span>
            </span>
          ) : (
            displayName
          )}
          {hasError && (
            <span
              className="album-name-error"
              title={t('album.decryptionError')}
              data-testid="album-name-error"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </span>
          )}
        </h3>
        <span className="album-count">
          {t('album.photoCount', { count: album.photoCount })}
        </span>
        {(() => {
          const badge = formatExpirationBadge(album.expiresAt, t);
          return badge ? (
            <span
              className={`expiration-badge expiration-badge--${badge.variant}`}
              data-testid="expiration-badge"
            >
              {badge.text}
            </span>
          ) : null;
        })()}
      </div>
    </button>
  );
}

export type { Album, ExpirationBadge };
