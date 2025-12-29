/**
 * Gallery Header Component
 *
 * Displays the gallery toolbar with view mode toggle, search, and actions.
 * Shows batch action buttons when in selection mode.
 * Album configuration is accessible via a dropdown menu for cleaner UX.
 */

import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import { UploadButton } from '../Upload/UploadButton';
import { AlbumSettingsDropdown } from './AlbumSettingsDropdown';
import type { GalleryViewMode } from './Gallery';
import { SearchInput } from './SearchInput';

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
  onEditDescription?: (() => void) | undefined;
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
  onEditDescription,
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
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                Delete ({selectedCount})
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
                <span className="view-toggle-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </span>
                <span className="view-toggle-label">Photos</span>
              </button>
              <button
                className={`view-toggle-btn ${viewMode === 'grid' ? 'view-toggle-btn--active' : ''}`}
                onClick={() => onViewModeChange('grid')}
                aria-pressed={viewMode === 'grid'}
                title="Grid view"
                data-testid="view-toggle-grid"
              >
                <span className="view-toggle-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </span>
                <span className="view-toggle-label">Grid</span>
              </button>
              <button
                className={`view-toggle-btn ${viewMode === 'map' ? 'view-toggle-btn--active' : ''}`}
                onClick={() => onViewModeChange('map')}
                aria-pressed={viewMode === 'map'}
                title={`Map view (${geotaggedCount} geotagged)`}
                data-testid="view-toggle-map"
              >
                <span className="view-toggle-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                </span>
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
              onEditDescription={onEditDescription}
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
