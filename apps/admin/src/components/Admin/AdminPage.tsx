/**
 * Admin Page Component
 *
 * Admin dashboard with tabs for managing users, albums, and quota settings.
 * Only accessible by users with IsAdmin flag.
 */

import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../../lib/api';
import type {
  AdminStatsResponse,
  AdminUserResponse,
  AdminAlbumResponse,
  QuotaDefaults,
  NearLimitsResponse,
} from '../../lib/api-types';

// =============================================================================
// Types
// =============================================================================

type AdminTab = 'dashboard' | 'users' | 'albums' | 'settings';

// =============================================================================
// Helpers
// =============================================================================

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** Format date to readable string */
function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Unknown';
  }
}

/** Calculate usage percentage */
function usagePercent(current: number, max: number | undefined, defaultMax: number): number {
  const effectiveMax = max ?? defaultMax;
  if (effectiveMax <= 0) return 0;
  return Math.min(100, Math.round((current / effectiveMax) * 100));
}

/** Convert bytes to GB for display */
function bytesToGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

/** Convert GB to bytes */
function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 * 1024 * 1024);
}

// =============================================================================
// Props
// =============================================================================

interface AdminPageProps {
  onBack: () => void;
}

// =============================================================================
// Dashboard Tab
// =============================================================================

interface DashboardTabProps {
  stats: AdminStatsResponse | null;
  nearLimits: NearLimitsResponse | null;
  onNavigateUsers: () => void;
  onNavigateAlbums: () => void;
  onNavigateSettings: () => void;
}

function DashboardTab({
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
            <span className="stat-value">{formatBytes(stats?.totalStorageBytes ?? 0)}</span>
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
                    {user.quota.maxAlbums && <> / {user.quota.maxAlbums} albums</>}
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
                    {album.limits?.maxPhotos && <> / {album.limits.maxPhotos} photos</>}
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
                    Album by {album.ownerAuthSub} - {formatBytes(album.totalSizeBytes)}
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

// =============================================================================
// Users Tab
// =============================================================================

interface UsersTabProps {
  users: AdminUserResponse[];
  defaults: QuotaDefaults;
  onRefresh: () => void;
}

function UsersTab({ users, defaults, onRefresh }: UsersTabProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingUser, setEditingUser] = useState<AdminUserResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredUsers = users.filter((user) =>
    user.authSub.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSaveQuota = async (
    maxStorageBytes: number | null,
    maxAlbums: number | null
  ) => {
    if (!editingUser) return;
    try {
      const api = getApi();
      await api.updateUserQuota(editingUser.id, { maxStorageBytes, maxAlbums });
      onRefresh();
      setEditingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update quota');
    }
  };

  const handleResetQuota = async () => {
    if (!editingUser) return;
    try {
      const api = getApi();
      await api.resetUserQuota(editingUser.id);
      onRefresh();
      setEditingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset quota');
    }
  };

  const handleToggleAdmin = async (user: AdminUserResponse) => {
    const action = user.isAdmin ? 'demote' : 'promote';
    const confirmed = window.confirm(
      `Are you sure you want to ${action} ${user.authSub} ${user.isAdmin ? 'from' : 'to'} admin?`
    );
    if (!confirmed) return;

    try {
      const api = getApi();
      if (user.isAdmin) {
        await api.demoteFromAdmin(user.id);
      } else {
        await api.promoteToAdmin(user.id);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} user`);
    }
  };

  return (
    <div className="users-tab">
      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="tab-header">
        <input
          type="search"
          placeholder="Search users..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Joined</th>
            <th>Storage</th>
            <th>Albums</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredUsers.map((user) => {
            const storagePercent = usagePercent(
              user.quota.currentStorageBytes,
              user.quota.maxStorageBytes,
              defaults.maxStorageBytes
            );
            const albumPercent = usagePercent(
              user.quota.currentAlbumCount,
              user.quota.maxAlbums,
              defaults.maxAlbums
            );

            return (
              <tr key={user.id} className={user.isAdmin ? 'admin-user' : ''}>
                <td>
                  <span className="user-auth">{user.authSub}</span>
                  {user.isAdmin && <span className="admin-badge">Admin</span>}
                </td>
                <td>{formatDate(user.createdAt)}</td>
                <td>
                  <div className="usage-bar">
                    <div
                      className={`usage-fill ${storagePercent >= 80 ? 'warning' : ''}`}
                      style={{ width: `${storagePercent}%` }}
                    />
                  </div>
                  <span className="usage-text">
                    {formatBytes(user.quota.currentStorageBytes)} /{' '}
                    {formatBytes(user.quota.maxStorageBytes ?? defaults.maxStorageBytes)}
                  </span>
                </td>
                <td>
                  <div className="usage-bar">
                    <div
                      className={`usage-fill ${albumPercent >= 80 ? 'warning' : ''}`}
                      style={{ width: `${albumPercent}%` }}
                    />
                  </div>
                  <span className="usage-text">
                    {user.quota.currentAlbumCount} / {user.quota.maxAlbums ?? defaults.maxAlbums}
                  </span>
                </td>
                <td className="actions-cell">
                  <button
                    className="btn-small btn-secondary"
                    onClick={() => setEditingUser(user)}
                  >
                    Edit
                  </button>
                  <button
                    className={`btn-small ${user.isAdmin ? 'btn-warning' : 'btn-primary'}`}
                    onClick={() => handleToggleAdmin(user)}
                  >
                    {user.isAdmin ? 'Demote' : 'Promote'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {filteredUsers.length === 0 && (
        <div className="empty-state">
          <p>No users found</p>
        </div>
      )}

      {editingUser && (
        <EditUserQuotaModal
          user={editingUser}
          defaults={defaults}
          onSave={handleSaveQuota}
          onReset={handleResetQuota}
          onClose={() => setEditingUser(null)}
        />
      )}
    </div>
  );
}

// =============================================================================
// Edit User Quota Modal
// =============================================================================

interface EditUserQuotaModalProps {
  user: AdminUserResponse;
  defaults: QuotaDefaults;
  onSave: (maxStorageBytes: number | null, maxAlbums: number | null) => void;
  onReset: () => void;
  onClose: () => void;
}

function EditUserQuotaModal({
  user,
  defaults,
  onSave,
  onReset,
  onClose,
}: EditUserQuotaModalProps) {
  const [maxStorageGb, setMaxStorageGb] = useState<string>(
    user.quota.maxStorageBytes
      ? String(user.quota.maxStorageBytes / (1024 * 1024 * 1024))
      : ''
  );
  const [maxAlbums, setMaxAlbums] = useState<string>(
    user.quota.maxAlbums ? String(user.quota.maxAlbums) : ''
  );
  const [useDefaults, setUseDefaults] = useState<boolean>(
    !user.quota.maxStorageBytes && !user.quota.maxAlbums
  );

  const handleSave = () => {
    if (useDefaults) {
      onReset();
    } else {
      const storageBytes = maxStorageGb ? parseFloat(maxStorageGb) * 1024 * 1024 * 1024 : null;
      const albums = maxAlbums ? parseInt(maxAlbums, 10) : null;
      onSave(storageBytes, albums);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Edit Quota: {user.authSub}</h2>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={useDefaults}
              onChange={(e) => setUseDefaults(e.target.checked)}
            />
            Use system defaults
          </label>
        </div>

        {!useDefaults && (
          <>
            <div className="form-group">
              <label htmlFor="maxStorage">Max Storage (GB)</label>
              <input
                id="maxStorage"
                type="number"
                min="0"
                step="0.1"
                value={maxStorageGb}
                onChange={(e) => setMaxStorageGb(e.target.value)}
                placeholder={String(defaults.maxStorageBytes / (1024 * 1024 * 1024))}
              />
              <span className="hint">Default: {formatBytes(defaults.maxStorageBytes)}</span>
            </div>

            <div className="form-group">
              <label htmlFor="maxAlbums">Max Albums</label>
              <input
                id="maxAlbums"
                type="number"
                min="0"
                step="1"
                value={maxAlbums}
                onChange={(e) => setMaxAlbums(e.target.value)}
                placeholder={String(defaults.maxAlbums)}
              />
              <span className="hint">Default: {defaults.maxAlbums}</span>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Albums Tab
// =============================================================================

interface AlbumsTabProps {
  albums: AdminAlbumResponse[];
  defaults: QuotaDefaults;
  onRefresh: () => void;
}

function AlbumsTab({ albums, defaults, onRefresh }: AlbumsTabProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingAlbum, setEditingAlbum] = useState<AdminAlbumResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredAlbums = albums.filter(
    (album) =>
      album.ownerAuthSub.toLowerCase().includes(searchTerm.toLowerCase()) ||
      album.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSaveLimits = async (maxPhotos: number | null, maxSizeBytes: number | null) => {
    if (!editingAlbum) return;
    try {
      const api = getApi();
      await api.updateAlbumLimits(editingAlbum.id, { maxPhotos, maxSizeBytes });
      onRefresh();
      setEditingAlbum(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update limits');
    }
  };

  const handleResetLimits = async () => {
    if (!editingAlbum) return;
    try {
      const api = getApi();
      await api.resetAlbumLimits(editingAlbum.id);
      onRefresh();
      setEditingAlbum(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset limits');
    }
  };

  return (
    <div className="albums-tab">
      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="tab-header">
        <input
          type="search"
          placeholder="Search by owner or ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Owner</th>
            <th>Created</th>
            <th>Photos</th>
            <th>Size</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredAlbums.map((album) => {
            const photoPercent = usagePercent(
              album.limits?.currentPhotoCount ?? album.photoCount,
              album.limits?.maxPhotos,
              defaults.maxPhotosPerAlbum
            );
            const sizePercent = usagePercent(
              album.limits?.currentSizeBytes ?? album.totalSizeBytes,
              album.limits?.maxSizeBytes,
              defaults.maxAlbumSizeBytes
            );

            return (
              <tr key={album.id}>
                <td title={album.id}>{album.id.slice(0, 8)}...</td>
                <td>{album.ownerAuthSub}</td>
                <td>{formatDate(album.createdAt)}</td>
                <td>
                  <div className="usage-bar">
                    <div
                      className={`usage-fill ${photoPercent >= 80 ? 'warning' : ''}`}
                      style={{ width: `${photoPercent}%` }}
                    />
                  </div>
                  <span className="usage-text">
                    {album.limits?.currentPhotoCount ?? album.photoCount} /{' '}
                    {album.limits?.maxPhotos ?? defaults.maxPhotosPerAlbum}
                  </span>
                </td>
                <td>
                  <div className="usage-bar">
                    <div
                      className={`usage-fill ${sizePercent >= 80 ? 'warning' : ''}`}
                      style={{ width: `${sizePercent}%` }}
                    />
                  </div>
                  <span className="usage-text">
                    {formatBytes(album.limits?.currentSizeBytes ?? album.totalSizeBytes)} /{' '}
                    {formatBytes(album.limits?.maxSizeBytes ?? defaults.maxAlbumSizeBytes)}
                  </span>
                </td>
                <td className="actions-cell">
                  <button
                    className="btn-small btn-secondary"
                    onClick={() => setEditingAlbum(album)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {filteredAlbums.length === 0 && (
        <div className="empty-state">
          <p>No albums found</p>
        </div>
      )}

      {editingAlbum && (
        <EditAlbumLimitsModal
          album={editingAlbum}
          defaults={defaults}
          onSave={handleSaveLimits}
          onReset={handleResetLimits}
          onClose={() => setEditingAlbum(null)}
        />
      )}
    </div>
  );
}

// =============================================================================
// Edit Album Limits Modal
// =============================================================================

interface EditAlbumLimitsModalProps {
  album: AdminAlbumResponse;
  defaults: QuotaDefaults;
  onSave: (maxPhotos: number | null, maxSizeBytes: number | null) => void;
  onReset: () => void;
  onClose: () => void;
}

function EditAlbumLimitsModal({
  album,
  defaults,
  onSave,
  onReset,
  onClose,
}: EditAlbumLimitsModalProps) {
  const [maxPhotos, setMaxPhotos] = useState<string>(
    album.limits?.maxPhotos ? String(album.limits.maxPhotos) : ''
  );
  const [maxSizeGb, setMaxSizeGb] = useState<string>(
    album.limits?.maxSizeBytes
      ? String(album.limits.maxSizeBytes / (1024 * 1024 * 1024))
      : ''
  );
  const [useDefaults, setUseDefaults] = useState<boolean>(
    !album.limits?.maxPhotos && !album.limits?.maxSizeBytes
  );

  const handleSave = () => {
    if (useDefaults) {
      onReset();
    } else {
      const photos = maxPhotos ? parseInt(maxPhotos, 10) : null;
      const sizeBytes = maxSizeGb ? parseFloat(maxSizeGb) * 1024 * 1024 * 1024 : null;
      onSave(photos, sizeBytes);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Edit Album Limits</h2>
        <p className="album-info">
          Owner: {album.ownerAuthSub}
          <br />
          ID: {album.id}
        </p>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={useDefaults}
              onChange={(e) => setUseDefaults(e.target.checked)}
            />
            Use system defaults
          </label>
        </div>

        {!useDefaults && (
          <>
            <div className="form-group">
              <label htmlFor="maxPhotos">Max Photos</label>
              <input
                id="maxPhotos"
                type="number"
                min="0"
                step="1"
                value={maxPhotos}
                onChange={(e) => setMaxPhotos(e.target.value)}
                placeholder={String(defaults.maxPhotosPerAlbum)}
              />
              <span className="hint">Default: {defaults.maxPhotosPerAlbum}</span>
            </div>

            <div className="form-group">
              <label htmlFor="maxSize">Max Size (GB)</label>
              <input
                id="maxSize"
                type="number"
                min="0"
                step="0.1"
                value={maxSizeGb}
                onChange={(e) => setMaxSizeGb(e.target.value)}
                placeholder={String(defaults.maxAlbumSizeBytes / (1024 * 1024 * 1024))}
              />
              <span className="hint">Default: {formatBytes(defaults.maxAlbumSizeBytes)}</span>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Settings Tab
// =============================================================================

interface SettingsTabProps {
  defaults: QuotaDefaults;
  onRefresh: () => void;
}

function SettingsTab({ defaults, onRefresh }: SettingsTabProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form state
  const [maxStorageGb, setMaxStorageGb] = useState(bytesToGb(defaults.maxStorageBytes));
  const [maxAlbums, setMaxAlbums] = useState(String(defaults.maxAlbums));
  const [maxPhotosPerAlbum, setMaxPhotosPerAlbum] = useState(String(defaults.maxPhotosPerAlbum));
  const [maxAlbumSizeGb, setMaxAlbumSizeGb] = useState(bytesToGb(defaults.maxAlbumSizeBytes));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const storageGb = parseFloat(maxStorageGb);
    const albums = parseInt(maxAlbums, 10);
    const photosPerAlbum = parseInt(maxPhotosPerAlbum, 10);
    const albumSizeGb = parseFloat(maxAlbumSizeGb);

    if (isNaN(storageGb) || storageGb <= 0) {
      setError('Max storage must be a positive number');
      return;
    }
    if (isNaN(albums) || albums <= 0) {
      setError('Max albums must be a positive integer');
      return;
    }
    if (isNaN(photosPerAlbum) || photosPerAlbum <= 0) {
      setError('Max photos per album must be a positive integer');
      return;
    }
    if (isNaN(albumSizeGb) || albumSizeGb <= 0) {
      setError('Max album size must be a positive number');
      return;
    }

    try {
      setSaving(true);
      const api = getApi();
      await api.updateQuotaDefaults({
        maxStorageBytes: gbToBytes(storageGb),
        maxAlbums: albums,
        maxPhotosPerAlbum: photosPerAlbum,
        maxAlbumSizeBytes: gbToBytes(albumSizeGb),
      });
      setSuccess(true);
      onRefresh();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setMaxStorageGb(bytesToGb(defaults.maxStorageBytes));
    setMaxAlbums(String(defaults.maxAlbums));
    setMaxPhotosPerAlbum(String(defaults.maxPhotosPerAlbum));
    setMaxAlbumSizeGb(bytesToGb(defaults.maxAlbumSizeBytes));
  };

  return (
    <div className="settings-tab">
      <p className="settings-description">
        Configure system-wide default limits. These apply to all users and albums unless
        overridden with custom limits.
      </p>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {success && (
        <div className="success-banner">
          <p>Settings saved successfully!</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="settings-form">
        <section className="settings-section">
          <h3>User Limits</h3>

          <div className="form-group">
            <label htmlFor="maxStorage">Default Max Storage per User (GB)</label>
            <input
              id="maxStorage"
              type="number"
              min="0.1"
              step="0.1"
              value={maxStorageGb}
              onChange={(e) => setMaxStorageGb(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="maxAlbums">Default Max Albums per User</label>
            <input
              id="maxAlbums"
              type="number"
              min="1"
              step="1"
              value={maxAlbums}
              onChange={(e) => setMaxAlbums(e.target.value)}
              required
            />
          </div>
        </section>

        <section className="settings-section">
          <h3>Album Limits</h3>

          <div className="form-group">
            <label htmlFor="maxPhotos">Default Max Photos per Album</label>
            <input
              id="maxPhotos"
              type="number"
              min="1"
              step="1"
              value={maxPhotosPerAlbum}
              onChange={(e) => setMaxPhotosPerAlbum(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="maxAlbumSize">Default Max Size per Album (GB)</label>
            <input
              id="maxAlbumSize"
              type="number"
              min="0.1"
              step="0.1"
              value={maxAlbumSizeGb}
              onChange={(e) => setMaxAlbumSizeGb(e.target.value)}
              required
            />
          </div>
        </section>

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={handleReset}>
            Reset
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
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
      const [statsData, nearLimitsData, usersData, albumsData, defaultsData] = await Promise.all([
        api.getStats(),
        api.getNearLimits(),
        api.listUsers(),
        api.listAllAlbums(),
        api.getQuotaDefaults(),
      ]);
      setStats(statsData);
      setNearLimits(nearLimitsData);
      setUsers(usersData);
      setAlbums(albumsData);
      setDefaults(defaultsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="admin-page loading">
        <div className="loading-spinner" />
        <p>Loading admin panel...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-page error">
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
    <div className="admin-page">
      <header className="admin-header">
        <button onClick={onBack} className="back-button">
          ← Back
        </button>
        <h1>Admin Panel</h1>
      </header>

      <nav className="admin-tabs">
        <button
          className={`tab-button ${currentTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setCurrentTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`tab-button ${currentTab === 'users' ? 'active' : ''}`}
          onClick={() => setCurrentTab('users')}
        >
          Users
        </button>
        <button
          className={`tab-button ${currentTab === 'albums' ? 'active' : ''}`}
          onClick={() => setCurrentTab('albums')}
        >
          Albums
        </button>
        <button
          className={`tab-button ${currentTab === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentTab('settings')}
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
