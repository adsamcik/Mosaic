import { useAlbums } from '../../hooks/useAlbums';
import { AlbumCard } from './AlbumCard';

interface AlbumListProps {
  onSelectAlbum: (albumId: string) => void;
}

/**
 * Album List Component
 * Displays all albums in a grid
 */
export function AlbumList({ onSelectAlbum }: AlbumListProps) {
  const { albums, isLoading, error } = useAlbums();

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
      </div>
    );
  }

  if (albums.length === 0) {
    return (
      <div className="album-list-empty">
        <p>No albums yet</p>
        <p className="text-muted">Create an album to get started</p>
      </div>
    );
  }

  return (
    <div className="album-list">
      <h2 className="album-list-title">Albums</h2>
      <div className="album-grid">
        {albums.map((album) => (
          <AlbumCard
            key={album.id}
            album={album}
            onClick={() => onSelectAlbum(album.id)}
          />
        ))}
      </div>
    </div>
  );
}
