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
  expiresAt: string | null | undefined
): ExpirationBadge | null {
  if (!expiresAt) return null;

  const days = Math.ceil(
    (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  if (days <= 0) return { text: 'Expired', variant: 'danger' };
  if (days === 1) return { text: 'Expires tomorrow', variant: 'warning' };
  if (days <= 7) return { text: `Expires in ${days} days`, variant: 'warning' };
  if (days <= 30)
    return { text: `Expires in ${Math.ceil(days / 7)} weeks`, variant: 'info' };
  return {
    text: `Expires ${new Date(expiresAt).toLocaleDateString()}`,
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
            title={coverError ? 'Failed to load cover' : 'No photos'}
          >
            📁
          </span>
        )}
      </div>
      <div className="album-info">
        <h3 className="album-name" data-testid="album-name">
          {isLoading ? (
            <span className="album-name-loading" data-testid="album-name-loading">
              <span className="loading-dots">•••</span>
            </span>
          ) : (
            displayName
          )}
          {hasError && (
            <span
              className="album-name-error"
              title="Failed to decrypt album name"
              data-testid="album-name-error"
            >
              ⚠️
            </span>
          )}
        </h3>
        <span className="album-count">
          {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
        </span>
        {(() => {
          const badge = formatExpirationBadge(album.expiresAt);
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
