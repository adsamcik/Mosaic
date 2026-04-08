import type {
  AdminStatsResponse,
  NearLimitsResponse,
} from '../../lib/api-types';
import { formatBytes } from './helpers';

export interface DashboardTabProps {
  stats: AdminStatsResponse | null;
  nearLimits: NearLimitsResponse | null;
  onNavigateUsers: () => void;
  onNavigateAlbums: () => void;
  onNavigateSettings: () => void;
}

export function DashboardTab({
  stats,
  nearLimits,
  onNavigateUsers,
  onNavigateAlbums,
  onNavigateSettings,
}: DashboardTabProps) {
  const hasWarnings =
    nearLimits &&
    (nearLimits.usersNearStorageLimit.length > 0 ||
      nearLimits.usersNearAlbumLimit.length > 0 ||
      nearLimits.albumsNearPhotoLimit.length > 0 ||
      nearLimits.albumsNearSizeLimit.length > 0);

  return (
    <div className="admin-dashboard-tab">
      {/* System Statistics */}
      <section className="stats-section">
        <h3>System Statistics</h3>
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-value">{stats?.totalUsers ?? 0}</span>
            <span className="stat-label">Total Users</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats?.totalAlbums ?? 0}</span>
            <span className="stat-label">Total Albums</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats?.totalPhotos ?? 0}</span>
            <span className="stat-label">Total Photos</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">
              {formatBytes(stats?.totalStorageBytes ?? 0)}
            </span>
            <span className="stat-label">Total Storage</span>
          </div>
        </div>
      </section>

      {/* Warnings Section */}
      {hasWarnings && (
        <section className="warnings-section">
          <h3>⚠️ Capacity Warnings</h3>
          <p className="warning-description">
            The following resources are at or above 80% of their limits.
          </p>

          {nearLimits.usersNearStorageLimit.length > 0 && (
            <div className="warning-group">
              <h4>Users Near Storage Limit</h4>
              <ul>
                {nearLimits.usersNearStorageLimit.map((user) => (
                  <li key={user.id}>
                    {user.authSub} - {formatBytes(user.totalStorageBytes)}
                    {user.quota.maxStorageBytes && (
                      <> / {formatBytes(user.quota.maxStorageBytes)}</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {nearLimits.usersNearAlbumLimit.length > 0 && (
            <div className="warning-group">
              <h4>Users Near Album Limit</h4>
              <ul>
                {nearLimits.usersNearAlbumLimit.map((user) => (
                  <li key={user.id}>
                    {user.authSub} - {user.quota.currentAlbumCount}
                    {user.quota.maxAlbums && (
                      <> / {user.quota.maxAlbums} albums</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {nearLimits.albumsNearPhotoLimit.length > 0 && (
            <div className="warning-group">
              <h4>Albums Near Photo Limit</h4>
              <ul>
                {nearLimits.albumsNearPhotoLimit.map((album) => (
                  <li key={album.id}>
                    Album by {album.ownerAuthSub} - {album.photoCount}
                    {album.limits?.maxPhotos && (
                      <> / {album.limits.maxPhotos} photos</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {nearLimits.albumsNearSizeLimit.length > 0 && (
            <div className="warning-group">
              <h4>Albums Near Size Limit</h4>
              <ul>
                {nearLimits.albumsNearSizeLimit.map((album) => (
                  <li key={album.id}>
                    Album by {album.ownerAuthSub} -{' '}
                    {formatBytes(album.totalSizeBytes)}
                    {album.limits?.maxSizeBytes && (
                      <> / {formatBytes(album.limits.maxSizeBytes)}</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Quick Actions */}
      <section className="actions-section">
        <h3>Quick Actions</h3>
        <div className="action-buttons">
          <button className="action-button" onClick={onNavigateSettings}>
            Configure Quota Defaults
          </button>
          <button className="action-button" onClick={onNavigateUsers}>
            Manage Users
          </button>
          <button className="action-button" onClick={onNavigateAlbums}>
            View All Albums
          </button>
        </div>
      </section>
    </div>
  );
}
