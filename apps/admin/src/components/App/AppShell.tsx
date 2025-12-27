import { useState } from 'react';
import { LogoutButton } from '../Auth/LogoutButton';
import { Gallery } from '../Gallery/Gallery';
import { AlbumList } from '../Albums/AlbumList';
import { SettingsPage } from '../Settings/SettingsPage';

type View = 'albums' | 'gallery' | 'settings';

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

  const handleOpenSettings = () => {
    setCurrentView('settings');
  };

  const handleBackFromSettings = () => {
    if (selectedAlbumId) {
      setCurrentView('gallery');
    } else {
      setCurrentView('albums');
    }
  };

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">🖼️ Mosaic</h1>
          {currentView === 'gallery' && selectedAlbumId && (
            <button onClick={handleBackToAlbums} className="back-button">
              ← Albums
            </button>
          )}
          {currentView === 'settings' && (
            <button onClick={handleBackFromSettings} className="back-button">
              ← Back
            </button>
          )}
        </div>
        <div className="header-right">
          {currentView !== 'settings' && (
            <button
              onClick={handleOpenSettings}
              className="settings-button"
              title="Settings"
              data-testid="settings-nav-button"
            >
              ⚙️
            </button>
          )}
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
        {currentView === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
