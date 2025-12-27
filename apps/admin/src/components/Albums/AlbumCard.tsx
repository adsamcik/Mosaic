interface Album {
  id: string;
  name: string;
  photoCount: number;
  createdAt: string;
}

interface AlbumCardProps {
  album: Album;
  onClick: () => void;
}

/**
 * Album Card Component
 * Displays a single album in the list
 */
export function AlbumCard({ album, onClick }: AlbumCardProps) {
  return (
    <button className="album-card" onClick={onClick} data-testid="album-card">
      <div className="album-cover">
        <span className="album-icon">📁</span>
      </div>
      <div className="album-info">
        <h3 className="album-name">{album.name}</h3>
        <span className="album-count">
          {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
        </span>
      </div>
    </button>
  );
}

export type { Album };
