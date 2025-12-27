import { useState } from 'react';
import { useAlbums } from '../../hooks/useAlbums';
import { AlbumCard } from './AlbumCard';
import { CreateAlbumDialog } from './CreateAlbumDialog';

interface AlbumListProps {
  onSelectAlbum: (albumId: string) => void;
}

/**
 * Album List Component
 * Displays all albums in a grid with create functionality
 */
export function AlbumList({ onSelectAlbum }: AlbumListProps) {
  const { albums, isLoading, error, refetch, createAlbum, isCreating, createError } = useAlbums();
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
        <p>Loading albums...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="album-list-error">
        <p>Failed to load albums: {error.message}</p>
        <button onClick={refetch} className="button-secondary">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="album-list" data-testid="album-list">
      <div className="album-list-header">
        <h2 className="album-list-title">Albums</h2>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="button-primary create-album-button"
          aria-label="Create new album"
          data-testid="create-album-trigger"
        >
          <span className="button-icon" aria-hidden="true">+</span>
          <span>Create Album</span>
        </button>
      </div>

      {albums.length === 0 ? (
        <div className="album-list-empty">
          <p>No albums yet</p>
          <p className="text-muted">Create an album to get started</p>
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
