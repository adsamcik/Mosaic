import { useEffect, useState } from 'react';
import { SyncProvider } from '../../contexts/SyncContext';
import { useAlbums, useRouter } from '../../hooks';
import { AlbumList } from '../Albums/AlbumList';
import { AdminPage } from '../Admin';
import { LogoutButton } from '../Auth/LogoutButton';
import { Gallery } from '../Gallery/Gallery';
import { SettingsPage } from '../Settings/SettingsPage';
import { getApi } from '../../lib/api';

/**
 * Main Application Shell
 * Contains navigation, header, and main content area
 * Uses URL-based routing for browser history support
 */
export function AppShell() {
  const { route, navigateToAlbums, navigateToGallery, navigateToSettings, navigateToAdmin } = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  
  // Get albums data - this is the single source of truth for album state
  const { albums, isLoading: albumsLoading, error: albumsError, refetch: refetchAlbums, createAlbum, isCreating, createError, deleteAlbum, renameAlbum } = useAlbums();

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
    navigateToGallery(albumId);
  };

  const handleBackToAlbums = () => {
    navigateToAlbums();
  };

  const handleOpenSettings = () => {
    navigateToSettings();
  };

  const handleOpenAdmin = () => {
    navigateToAdmin();
  };

  const handleBackFromSettings = () => {
    if (route.view === 'gallery' && route.albumId) {
      navigateToGallery(route.albumId);
    } else {
      navigateToAlbums();
    }
  };

  const handleBackFromAdmin = () => {
    navigateToAlbums();
  };

  // Derive current view and selected album from route
  const currentView = route.view;
  const selectedAlbumId = route.view === 'gallery' ? route.albumId : null;

  return (
    <SyncProvider>
      <div className="app-shell" data-testid="app-shell">
        <header className="app-header">
          <div className="header-left">
            <h1 className="app-title">Mosaic</h1>
            {currentView === 'gallery' && selectedAlbumId && (
              <button onClick={handleBackToAlbums} className="back-button" title="Back to Albums">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                <span>Albums</span>
              </button>
            )}
            {currentView === 'settings' && (
              <button onClick={handleBackFromSettings} className="back-button" title="Back">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                <span>Back</span>
              </button>
            )}
            {currentView === 'admin' && (
              <button onClick={handleBackFromAdmin} className="back-button" title="Back">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              <span>Back</span>
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
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </button>
          )}
          {currentView !== 'settings' && currentView !== 'admin' && (
            <button
              onClick={handleOpenSettings}
              className="settings-button"
              title="Settings"
              data-testid="settings-nav-button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          )}
          <LogoutButton />
        </div>
      </header>

      <main className="app-main">
        {currentView === 'albums' && (
          <AlbumList
            onSelectAlbum={handleSelectAlbum}
            albums={albums}
            isLoading={albumsLoading}
            error={albumsError}
            refetch={refetchAlbums}
            createAlbum={createAlbum}
            isCreating={isCreating}
            createError={createError}
          />
        )}
        {currentView === 'gallery' && selectedAlbumId && (
          <Gallery 
            albumId={selectedAlbumId}
            albumName={albums.find(a => a.id === selectedAlbumId)?.name}
            onDeleteAlbum={deleteAlbum}
            onRenameAlbum={renameAlbum}
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
