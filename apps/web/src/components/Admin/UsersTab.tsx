import { useState } from 'react';
import { getApi } from '../../lib/api';
import type { AdminUserResponse, QuotaDefaults } from '../../lib/api-types';
import { formatBytes, formatDate, usagePercent } from './helpers';

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
      : '',
  );
  const [maxAlbums, setMaxAlbums] = useState<string>(
    user.quota.maxAlbums ? String(user.quota.maxAlbums) : '',
  );
  const [useDefaults, setUseDefaults] = useState<boolean>(
    !user.quota.maxStorageBytes && !user.quota.maxAlbums,
  );

  const handleSave = () => {
    if (useDefaults) {
      onReset();
    } else {
      const storageBytes = maxStorageGb
        ? parseFloat(maxStorageGb) * 1024 * 1024 * 1024
        : null;
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
                placeholder={String(
                  defaults.maxStorageBytes / (1024 * 1024 * 1024),
                )}
              />
              <span className="hint">
                Default: {formatBytes(defaults.maxStorageBytes)}
              </span>
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
// Users Tab
// =============================================================================

export interface UsersTabProps {
  users: AdminUserResponse[];
  defaults: QuotaDefaults;
  onRefresh: () => void;
}

export function UsersTab({ users, defaults, onRefresh }: UsersTabProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingUser, setEditingUser] = useState<AdminUserResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const filteredUsers = users.filter((user) =>
    user.authSub.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const handleSaveQuota = async (
    maxStorageBytes: number | null,
    maxAlbums: number | null,
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
      `Are you sure you want to ${action} ${user.authSub} ${user.isAdmin ? 'from' : 'to'} admin?`,
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

      <table className="admin-table" data-testid="users-table">
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
              defaults.maxStorageBytes,
            );
            const albumPercent = usagePercent(
              user.quota.currentAlbumCount,
              user.quota.maxAlbums,
              defaults.maxAlbums,
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
                    {formatBytes(
                      user.quota.maxStorageBytes ?? defaults.maxStorageBytes,
                    )}
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
                    {user.quota.currentAlbumCount} /{' '}
                    {user.quota.maxAlbums ?? defaults.maxAlbums}
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
