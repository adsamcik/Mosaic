/**
 * Gallery Header Component
 *
 * Displays the gallery toolbar with view mode toggle, search, and actions.
 * Respects user permissions for showing/hiding actions.
 */

import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import type { GalleryViewMode } from './Gallery';
import { SearchInput } from './SearchInput';
import { UploadButton } from '../Upload/UploadButton';

interface GalleryHeaderProps {
  albumId: string;
  viewMode: GalleryViewMode;
  onViewModeChange: (mode: GalleryViewMode) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  geotaggedCount: number;
  onShowMembers: () => void;
  onShowShareLinks: () => void;
}

/**
 * Gallery header with view controls and actions
 */
export function GalleryHeader({
  albumId,
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  geotaggedCount,
  onShowMembers,
  onShowShareLinks,
}: GalleryHeaderProps) {
  const permissions = useAlbumPermissions();

  return (
    <div className="gallery-header">
      <h2 className="gallery-title">Photos</h2>

      {/* Search Input */}
      <SearchInput
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search photos..."
        className="gallery-search"
      />

      <div className="gallery-actions">
        {/* View Mode Toggle */}
        <div className="view-toggle" role="group" aria-label="View mode">
          <button
            className={`view-toggle-btn ${viewMode === 'justified' ? 'view-toggle-btn--active' : ''}`}
            onClick={() => onViewModeChange('justified')}
            aria-pressed={viewMode === 'justified'}
            title="Justified view (like Google Photos)"
            data-testid="view-toggle-justified"
          >
            <span className="view-toggle-icon">⊞</span>
            <span className="view-toggle-label">Photos</span>
          </button>
          <button
            className={`view-toggle-btn ${viewMode === 'grid' ? 'view-toggle-btn--active' : ''}`}
            onClick={() => onViewModeChange('grid')}
            aria-pressed={viewMode === 'grid'}
            title="Grid view"
            data-testid="view-toggle-grid"
          >
            <span className="view-toggle-icon">▦</span>
            <span className="view-toggle-label">Grid</span>
          </button>
          <button
            className={`view-toggle-btn ${viewMode === 'map' ? 'view-toggle-btn--active' : ''}`}
            onClick={() => onViewModeChange('map')}
            aria-pressed={viewMode === 'map'}
            title={`Map view (${geotaggedCount} geotagged)`}
            data-testid="view-toggle-map"
          >
            <span className="view-toggle-icon">🗺️</span>
            <span className="view-toggle-label">Map</span>
            {geotaggedCount > 0 && (
              <span className="view-toggle-badge">{geotaggedCount}</span>
            )}
          </button>
        </div>

        {/* Share button - visible to all members */}
        <button
          className="button-secondary share-button"
          onClick={onShowMembers}
          aria-label="Manage album members"
          data-testid="share-button"
        >
          <span className="share-icon">👥</span>
          <span className="button-label">Share</span>
        </button>

        {/* Links button - owners only */}
        {permissions.canManageShareLinks && (
          <button
            className="button-secondary share-links-button"
            onClick={onShowShareLinks}
            aria-label="Manage share links"
            data-testid="share-links-button"
          >
            <span className="share-links-icon">🔗</span>
            <span className="button-label">Links</span>
          </button>
        )}

        {/* Upload button - editors and owners only */}
        {permissions.canUpload && <UploadButton albumId={albumId} />}
      </div>
    </div>
  );
}
