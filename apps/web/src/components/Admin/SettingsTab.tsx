import { useState } from 'react';
import { getApi } from '../../lib/api';
import type { QuotaDefaults } from '../../lib/api-types';
import { bytesToGb, gbToBytes } from './helpers';

export interface SettingsTabProps {
  defaults: QuotaDefaults;
  onRefresh: () => void;
}

export function SettingsTab({ defaults, onRefresh }: SettingsTabProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form state
  const [maxStorageGb, setMaxStorageGb] = useState(
    bytesToGb(defaults.maxStorageBytes),
  );
  const [maxAlbums, setMaxAlbums] = useState(String(defaults.maxAlbums));
  const [maxPhotosPerAlbum, setMaxPhotosPerAlbum] = useState(
    String(defaults.maxPhotosPerAlbum),
  );
  const [maxAlbumSizeGb, setMaxAlbumSizeGb] = useState(
    bytesToGb(defaults.maxAlbumSizeBytes),
  );

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
        Configure system-wide default limits. These apply to all users and
        albums unless overridden with custom limits.
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
            <label htmlFor="maxStorage">
              Default Max Storage per User (GB)
            </label>
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
            <label htmlFor="maxAlbumSize">
              Default Max Size per Album (GB)
            </label>
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
