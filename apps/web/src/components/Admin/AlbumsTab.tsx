import { useState } from 'react';
import { getApi } from '../../lib/api';
import type { AdminAlbumResponse, QuotaDefaults } from '../../lib/api-types';
import { formatBytes, formatDate, usagePercent } from './helpers';

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
    album.limits?.maxPhotos ? String(album.limits.maxPhotos) : '',
  );
  const [maxSizeGb, setMaxSizeGb] = useState<string>(
    album.limits?.maxSizeBytes
      ? String(album.limits.maxSizeBytes / (1024 * 1024 * 1024))
      : '',
  );
  const [useDefaults, setUseDefaults] = useState<boolean>(
    !album.limits?.maxPhotos && !album.limits?.maxSizeBytes,
  );

  const handleSave = () => {
    if (useDefaults) {
      onReset();
    } else {
      const photos = maxPhotos ? parseInt(maxPhotos, 10) : null;
      const sizeBytes = maxSizeGb
        ? parseFloat(maxSizeGb) * 1024 * 1024 * 1024
        : null;
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
              <span className="hint">
                Default: {defaults.maxPhotosPerAlbum}
              </span>
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
                placeholder={String(
                  defaults.maxAlbumSizeBytes / (1024 * 1024 * 1024),
                )}
              />
              <span className="hint">
                Default: {formatBytes(defaults.maxAlbumSizeBytes)}
              </span>
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

export interface AlbumsTabProps {
  albums: AdminAlbumResponse[];
  defaults: QuotaDefaults;
  onRefresh: () => void;
}

export function AlbumsTab({ albums, defaults, onRefresh }: AlbumsTabProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingAlbum, setEditingAlbum] = useState<AdminAlbumResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const filteredAlbums = albums.filter(
    (album) =>
      album.ownerAuthSub.toLowerCase().includes(searchTerm.toLowerCase()) ||
      album.id.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const handleSaveLimits = async (
    maxPhotos: number | null,
    maxSizeBytes: number | null,
  ) => {
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

      <table className="admin-table" data-testid="albums-table">
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
              defaults.maxPhotosPerAlbum,
            );
            const sizePercent = usagePercent(
              album.limits?.currentSizeBytes ?? album.totalSizeBytes,
              album.limits?.maxSizeBytes,
              defaults.maxAlbumSizeBytes,
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
                    {formatBytes(
                      album.limits?.currentSizeBytes ?? album.totalSizeBytes,
                    )}{' '}
                    /{' '}
                    {formatBytes(
                      album.limits?.maxSizeBytes ?? defaults.maxAlbumSizeBytes,
                    )}
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
