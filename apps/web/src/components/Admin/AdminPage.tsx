/**
 * Admin Page Component
 *
 * Admin dashboard with tabs for managing users, albums, and quota settings.
 * Only accessible by users with IsAdmin flag.
 */

import { useCallback, useEffect, useState } from 'react';
import { getApi, paginateAll } from '../../lib/api';
import type {
  AdminStatsResponse,
  AdminUserResponse,
  AdminAlbumResponse,
  QuotaDefaults,
  NearLimitsResponse,
} from '../../lib/api-types';
import type { AdminTab } from './types';
import { DashboardTab } from './DashboardTab';
import { UsersTab } from './UsersTab';
import { AlbumsTab } from './AlbumsTab';
import { SettingsTab } from './SettingsTab';

// =============================================================================
// Props
// =============================================================================

interface AdminPageProps {
  onBack: () => void;
}

// =============================================================================
// Main Component
// =============================================================================

export function AdminPage({ onBack }: AdminPageProps) {
  const [currentTab, setCurrentTab] = useState<AdminTab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Data state
  const [stats, setStats] = useState<AdminStatsResponse | null>(null);
  const [nearLimits, setNearLimits] = useState<NearLimitsResponse | null>(null);
  const [users, setUsers] = useState<AdminUserResponse[]>([]);
  const [albums, setAlbums] = useState<AdminAlbumResponse[]>([]);
  const [defaults, setDefaults] = useState<QuotaDefaults | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const api = getApi();
      const [statsData, nearLimitsData, usersData, albumsData, defaultsData] =
        await Promise.all([
          api.getStats(),
          api.getNearLimits(),
          paginateAll((skip, take) => api.listUsers(skip, take)),
          paginateAll((skip, take) => api.listAllAlbums(skip, take)),
          api.getQuotaDefaults(),
        ]);
      setStats(statsData);
      setNearLimits(nearLimitsData);
      setUsers(usersData);
      setAlbums(albumsData);
      setDefaults(defaultsData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load admin data',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="admin-page loading" data-testid="admin-page">
        <div className="loading-spinner" />
        <p>Loading admin panel...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-page error" data-testid="admin-page">
        <h2>Error</h2>
        <p>{error}</p>
        <div className="error-actions">
          <button onClick={onBack}>← Back</button>
          <button onClick={loadData}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page" data-testid="admin-page">
      <header className="admin-header">
        <button onClick={onBack} className="back-button">
          ← Back
        </button>
        <h1>Admin Panel</h1>
      </header>

      <nav className="admin-tabs" role="tablist">
        <button
          className={`tab-button ${currentTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setCurrentTab('dashboard')}
          role="tab"
          aria-selected={currentTab === 'dashboard'}
        >
          Dashboard
        </button>
        <button
          className={`tab-button ${currentTab === 'users' ? 'active' : ''}`}
          onClick={() => setCurrentTab('users')}
          role="tab"
          aria-selected={currentTab === 'users'}
        >
          Users
        </button>
        <button
          className={`tab-button ${currentTab === 'albums' ? 'active' : ''}`}
          onClick={() => setCurrentTab('albums')}
          role="tab"
          aria-selected={currentTab === 'albums'}
        >
          Albums
        </button>
        <button
          className={`tab-button ${currentTab === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentTab('settings')}
          role="tab"
          aria-selected={currentTab === 'settings'}
        >
          Settings
        </button>
      </nav>

      <main className="admin-content">
        {currentTab === 'dashboard' && (
          <DashboardTab
            stats={stats}
            nearLimits={nearLimits}
            onNavigateUsers={() => setCurrentTab('users')}
            onNavigateAlbums={() => setCurrentTab('albums')}
            onNavigateSettings={() => setCurrentTab('settings')}
          />
        )}
        {currentTab === 'users' && defaults && (
          <UsersTab users={users} defaults={defaults} onRefresh={loadData} />
        )}
        {currentTab === 'albums' && defaults && (
          <AlbumsTab albums={albums} defaults={defaults} onRefresh={loadData} />
        )}
        {currentTab === 'settings' && defaults && (
          <SettingsTab defaults={defaults} onRefresh={loadData} />
        )}
      </main>
    </div>
  );
}
