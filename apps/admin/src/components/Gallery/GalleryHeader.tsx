/**
 * Gallery Header Component
 *
 * Displays the gallery toolbar with view mode toggle, search, and actions.
 * Shows batch action buttons when in selection mode.
 * Album configuration is accessible via a dropdown menu for cleaner UX.
 */

import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const permissions = useAlbumPermissions();
  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedCount = selection?.selectedCount ?? 0;

  return (
    <div className={`gallery-header ${isSelectionMode ? 'gallery-header--selection-mode' : ''}`}>
      <h2 className="gallery-title">
        {isSelectionMode ? (
          <span className="gallery-title-selection">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="selection-icon">
              <polyline points="9 11 12 14 22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            {t('gallery.selectPhotos')}
          </span>
        ) : (
          t('gallery.title')
        )}
      </h2>

      {/* Search Input - hide when in selection mode */}
      {!isSelectionMode && (
        <SearchInput
          value={searchQuery}
          onChange={onSearchChange}
          placeholder={t('gallery.searchPlaceholder')}
          className="gallery-search"
        />
      )}

      {/* Selection mode hint - shown instead of search when selecting */}
      {isSelectionMode && (
        <div className="selection-mode-hint">
          {selectedCount === 0 ? (
            <span>{t('gallery.selectionHint')}</span>
          ) : (
            <span>{t('gallery.photoSelected', { count: selectedCount })}</span>
          )}
        </div>
      )}

      <div className="gallery-actions">
        {/* Selection Mode: simplified header - main actions are in floating bar */}
        {isSelectionMode ? (
          <button
            className="button-secondary selection-cancel-btn"
            onClick={selectionActions?.toggleSelectionMode}
            data-testid="selection-mode-button"
            title={t('gallery.exitSelectionModeTitle')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            {t('common.cancel')}
          </button>
        ) : (
          <>
            {/* View Mode Toggle */}
            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                className={`view-toggle-btn ${viewMode === 'justified' ? 'view-toggle-btn--active' : ''}`}
                onClick={() => onViewModeChange('justified')}
                aria-pressed={viewMode === 'justified'}
                title={t('gallery.viewPhotos')}
                data-testid="view-toggle-justified"
              >
                <span className="view-toggle-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </span>
                <span className="view-toggle-label">{t('gallery.photos')}</span>
              </button>
              <button
                className={`view-toggle-btn ${viewMode === 'grid' ? 'view-toggle-btn--active' : ''}`}
                onClick={() => onViewModeChange('grid')}
                aria-pressed={viewMode === 'grid'}
                title={t('gallery.viewGrid')}
                data-testid="view-toggle-grid"
              >
                <span className="view-toggle-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </span>
                <span className="view-toggle-label">{t('gallery.grid')}</span>
              </button>

              <button
                className={`view-toggle-btn ${viewMode === 'mosaic' ? 'view-toggle-btn--active' : ''}`}
                onClick={() => onViewModeChange('mosaic')}
                aria-pressed={viewMode === 'mosaic'}
                title={t('gallery.viewMosaic')}
                data-testid="view-toggle-mosaic"
              >
                <span className="view-toggle-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h8v8H4z"/><path d="M4 16h8v4H4z"/><path d="M16 4h4v4h-4z"/><path d="M16 12h4v8h-4z"/></svg>
                </span>
                <span className="view-toggle-label">{t('gallery.mosaic')}</span>
              </button>

              {geotaggedCount > 0 && (
                <button
                  className={`view-toggle-btn ${viewMode === 'map' ? 'view-toggle-btn--active' : ''}`}
                  onClick={() => onViewModeChange('map')}
                  aria-pressed={viewMode === 'map'}
                  title={t('gallery.viewMap', { count: geotaggedCount })}
                  data-testid="view-toggle-map"
                >
                  <span className="view-toggle-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
                  </span>
                  <span className="view-toggle-label">{t('gallery.map')}</span>
                  <span className="view-toggle-badge">{geotaggedCount}</span>
                </button>
              )}
            </div>

            {/* Select button to enter selection mode */}
            {permissions.canSelect && selectionActions && (
              <button
                className="button-secondary"
                onClick={selectionActions.toggleSelectionMode}
                data-testid="selection-mode-button"
              >
                {t('gallery.select')}
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
