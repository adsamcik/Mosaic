import { useEffect, useState } from 'react';
import { SyncProvider } from '../../contexts/SyncContext';
import { useAlbums } from '../../hooks/useAlbums';
import { AlbumList } from '../Albums/AlbumList';
import { AdminPage } from '../Admin';
import { LogoutButton } from '../Auth/LogoutButton';
import { Gallery } from '../Gallery/Gallery';
import { SettingsPage } from '../Settings/SettingsPage';
import { getApi } from '../../lib/api';

type View = 'albums' | 'gallery' | 'settings' | 'admin';

/**
 * Main Application Shell
 * Contains navigation, header, and main content area
 */
export function AppShell() {
  const [currentView, setCurrentView] = useState<View>('albums');
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  
  // Get albums data for album name display and delete functionality
  const { albums, deleteAlbum } = useAlbums();

  // Check if current user is admin on mount
  useEffect(() => {
    const checkAdmin = async () => {
      try {
        const api = getApi();
        const user = await api.getCurrentUser();
        setIsAdmin(user.isAdmin ?? false);
      } catch {
        // Ignore errors - user is not admin
      }
    };
    void checkAdmin();
  }, []);

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

  const handleOpenAdmin = () => {
    setCurrentView('admin');
  };

  const handleBackFromSettings = () => {
    if (selectedAlbumId) {
      setCurrentView('gallery');
    } else {
      setCurrentView('albums');
    }
  };

  const handleBackFromAdmin = () => {
    setCurrentView('albums');
  };

  return (
    <SyncProvider>
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
            {currentView === 'admin' && (
              <button onClick={handleBackFromAdmin} className="back-button">
              ← Back
            </button>
          )}
        </div>
        <div className="header-right">
          {isAdmin && currentView !== 'admin' && (
            <button
              onClick={handleOpenAdmin}
              className="admin-button"
              title="Admin Panel"
              data-testid="admin-nav-button"
            >
              🛡️
            </button>
          )}
          {currentView !== 'settings' && currentView !== 'admin' && (
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
          <Gallery 
            albumId={selectedAlbumId}
            albumName={albums.find(a => a.id === selectedAlbumId)?.name}
            onDeleteAlbum={deleteAlbum}
            onAlbumDeleted={handleBackToAlbums}
          />
        )}
        {currentView === 'settings' && <SettingsPage />}
        {currentView === 'admin' && <AdminPage onBack={handleBackFromAdmin} />}
      </main>
      </div>
    </SyncProvider>
  );
}
