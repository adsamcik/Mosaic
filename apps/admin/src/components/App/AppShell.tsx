import { useState } from 'react';
import { LogoutButton } from '../Auth/LogoutButton';
import { Gallery } from '../Gallery/Gallery';
import { AlbumList } from '../Albums/AlbumList';

type View = 'albums' | 'gallery';

/**
 * Main Application Shell
 * Contains navigation, header, and main content area
 */
export function AppShell() {
  const [currentView, setCurrentView] = useState<View>('albums');
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);

  const handleSelectAlbum = (albumId: string) => {
    setSelectedAlbumId(albumId);
    setCurrentView('gallery');
  };

  const handleBackToAlbums = () => {
    setSelectedAlbumId(null);
    setCurrentView('albums');
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">🖼️ Mosaic</h1>
          {currentView === 'gallery' && selectedAlbumId && (
            <button onClick={handleBackToAlbums} className="back-button">
              ← Albums
            </button>
          )}
        </div>
        <div className="header-right">
          <LogoutButton />
        </div>
      </header>

      <main className="app-main">
        {currentView === 'albums' && (
          <AlbumList onSelectAlbum={handleSelectAlbum} />
        )}
        {currentView === 'gallery' && selectedAlbumId && (
          <Gallery albumId={selectedAlbumId} />
        )}
      </main>
    </div>
  );
}
