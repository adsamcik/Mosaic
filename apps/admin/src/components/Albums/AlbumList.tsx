import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Album } from './AlbumCard';
import { AlbumCard } from './AlbumCard';
import { CreateAlbumDialog } from './CreateAlbumDialog';

interface AlbumListProps {
  onSelectAlbum: (albumId: string) => void;
  /** Albums to display - passed from parent for shared state */
  albums: Album[];
  /** Whether albums are loading */
  isLoading: boolean;
  /** Error loading albums */
  error: Error | null;
  /** Refresh albums */
  refetch: () => Promise<void>;
  /** Create a new album */
  createAlbum: (name: string) => Promise<Album | null>;
  /** Whether album creation is in progress */
  isCreating: boolean;
  /** Error from album creation */
  createError: string | null;
}

/**
 * Album List Component
 * Displays all albums in a grid with create functionality
 */
export function AlbumList({
  onSelectAlbum,
  albums,
  isLoading,
  error,
  refetch,
  createAlbum,
  isCreating,
  createError,
}: AlbumListProps) {
  const { t } = useTranslation();
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const handleCreate = async (name: string) => {
    const album = await createAlbum(name);
    if (album) {
      setShowCreateDialog(false);
    }
  };

  const handleCloseDialog = () => {
    if (!isCreating) {
      setShowCreateDialog(false);
    }
  };

  if (isLoading) {
    return (
      <div className="album-list-loading">
        <div className="loading-spinner" />
        <p>{t('album.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="album-list-error">
        <p>{t('album.error', { error: error.message })}</p>
        <button onClick={refetch} className="button-secondary">
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="album-list" data-testid="album-list">
      <div className="album-list-header">
        <h2 className="album-list-title">{t('album.title')}</h2>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="button-primary create-album-button"
          aria-label={t('album.createAlbumAriaLabel')}
          data-testid="create-album-trigger"
        >
          <span className="button-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </span>
          <span>{t('album.createAlbum')}</span>
        </button>
      </div>

      {albums.length === 0 ? (
        <div className="album-list-empty">
          <p>{t('album.empty')}</p>
          <p className="text-muted">{t('album.emptyHint')}</p>
        </div>
      ) : (
        <div className="album-grid">
          {albums.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              onClick={() => onSelectAlbum(album.id)}
            />
          ))}
        </div>
      )}

      <CreateAlbumDialog
        isOpen={showCreateDialog}
        onClose={handleCloseDialog}
        onCreate={handleCreate}
        isCreating={isCreating}
        error={createError}
      />
    </div>
  );
}
