/**
 * Gallery Header Component
 *
 * Displays the gallery toolbar with view mode toggle, search, and actions.
 * Shows batch action buttons when in selection mode.
 * Album configuration is accessible via a dropdown menu for cleaner UX.
 */

import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import type { GalleryViewMode } from './Gallery';
import { SearchInput } from './SearchInput';
import { UploadButton } from '../Upload/UploadButton';
import { AlbumSettingsDropdown } from './AlbumSettingsDropdown';

interface SelectionState {
  isSelectionMode: boolean;
  selectedCount: number;
}

interface SelectionActions {
  toggleSelectionMode: () => void;
  selectAll: () => void;
  clearSelection: () => void;
  onBulkDelete: () => void;
}

interface GalleryHeaderProps {
  albumId: string;
  viewMode: GalleryViewMode;
  onViewModeChange: (mode: GalleryViewMode) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  geotaggedCount: number;
  onShowMembers: () => void;
  onShowShareLinks: () => void;
  onRenameAlbum?: (() => void) | undefined;
  onDeleteAlbum?: (() => void) | undefined;
  /** Selection state for batch operations */
  selection?: SelectionState;
  /** Selection actions for batch operations */
  selectionActions?: SelectionActions;
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
  onRenameAlbum,
  onDeleteAlbum,
  selection,
  selectionActions,
}: GalleryHeaderProps) {
  const permissions = useAlbumPermissions();
  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedCount = selection?.selectedCount ?? 0;

  return (
    <div className="gallery-header">
      <h2 className="gallery-title">Photos</h2>

      {/* Search Input - hide when in selection mode */}
      {!isSelectionMode && (
        <SearchInput
          value={searchQuery}
          onChange={onSearchChange}
          placeholder="Search photos..."
          className="gallery-search"
        />
      )}

      <div className="gallery-actions">
        {/* Selection Mode Controls */}
        {isSelectionMode ? (
          <>
            {/* Selection count */}
            {selectedCount > 0 && (
              <span className="selection-count" data-testid="selection-count">
                {selectedCount} selected
              </span>
            )}

            {/* Select All button */}
            <button
              className="button-secondary"
              onClick={selectionActions?.selectAll}
              data-testid="select-all-button"
            >
              Select All
            </button>

            {/* Clear Selection button */}
            {selectedCount > 0 && (
              <button
                className="button-secondary"
                onClick={selectionActions?.clearSelection}
                data-testid="clear-selection-button"
              >
                Clear
              </button>
            )}

            {/* Bulk Delete button */}
            {selectedCount > 0 && permissions.canDelete && (
              <button
                className="button-danger"
                onClick={selectionActions?.onBulkDelete}
                data-testid="bulk-delete-button"
              >
                🗑️ Delete ({selectedCount})
              </button>
            )}

            {/* Cancel Selection button */}
            <button
              className="button-secondary button-active"
              onClick={selectionActions?.toggleSelectionMode}
              data-testid="selection-mode-button"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
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

            {/* Select button to enter selection mode */}
            {permissions.canSelect && selectionActions && (
              <button
                className="button-secondary"
                onClick={selectionActions.toggleSelectionMode}
                data-testid="selection-mode-button"
              >
                Select
              </button>
            )}

            {/* Album Settings Dropdown - contains Share, Links, Rename, Delete */}
            <AlbumSettingsDropdown
              onShowMembers={onShowMembers}
              onShowShareLinks={onShowShareLinks}
              onRenameAlbum={onRenameAlbum}
              onDeleteAlbum={onDeleteAlbum}
            />

            {/* Upload button - editors and owners only */}
            {permissions.canUpload && <UploadButton albumId={albumId} />}
          </>
        )}
      </div>
    </div>
  );
}
