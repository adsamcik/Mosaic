import { useAlbumCover } from '../../hooks/useAlbumCover';

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
      </div>
    </button>
  );
}

export type { Album };
