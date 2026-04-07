import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlbumContentProvider,
  useAlbumContent,
} from '../../contexts/AlbumContentContext';
import { AlbumPermissionsProvider } from '../../contexts/AlbumPermissionsContext';
import { useAutoSync } from '../../contexts/SyncContext';
import { UploadProvider } from '../../contexts/UploadContext';
import { useAlbumMembers } from '../../hooks/useAlbumMembers';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoActions } from '../../hooks/usePhotoActions';
import { useAlbumDownload } from '../../hooks/useAlbumDownload';
import { usePhotoList } from '../../hooks/usePhotoList';
import { useSelection } from '../../hooks/useSelection';
import { useSync } from '../../hooks/useSync';
import { createLogger } from '../../lib/logger';
import { getApi } from '../../lib/api';
import type { Album as ApiAlbum } from '../../lib/api-types';
import { Dialog } from '../Shared/Dialog';
import { SyncCoordinatorProvider } from '../../lib/sync-coordinator';
import type { GeoFeature, PhotoMeta } from '../../workers/types';
import { DeleteAlbumDialog, RenameAlbumDialog, AlbumExpirationSettings } from '../Albums';
import { ContentEditor } from '../Content';
import { MemberList } from '../Members/MemberList';
import { ShareLinksPanel } from '../ShareLinks/ShareLinksPanel';
import { DropZone } from '../Upload/DropZone';
import { UploadErrorToast } from '../Upload/UploadErrorToast';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { DownloadProgressOverlay } from './DownloadProgressOverlay';
import { GalleryHeader } from './GalleryHeader';
import { MapView } from './MapView';
import { MosaicPhotoGrid } from './MosaicPhotoGrid';
import { PhotoGrid } from './PhotoGrid';
import { PhotoLightbox } from './PhotoLightbox';
import { SelectionActionBar } from './SelectionActionBar';
import { SquarePhotoGrid } from './SquarePhotoGrid';

const log = createLogger('Gallery');

/** View mode for the gallery */
export type GalleryViewMode = 'grid' | 'justified' | 'mosaic' | 'map' | 'story';

/**
 * Inner story view component that uses the AlbumContentContext
 */
function StoryViewContent() {
  const { t } = useTranslation();
  const {
    albumId,
    loadState,
    saveState,
    document,
    isDirty,
    canEdit,
    loadContent,
    updateBlock,
    addBlock,
    removeBlock,
    moveBlock,
    saveContent,
    createInitialContent,
    errorMessage,
  } = useAlbumContent();

  // Load content on mount
  useEffect(() => {
    if (loadState === 'idle') {
      void loadContent();
    }
  }, [loadState, loadContent]);

  // Auto-save when content is dirty (debounced)
  useEffect(() => {
    if (!isDirty || saveState === 'saving') return;

    const timer = setTimeout(() => {
      void saveContent();
    }, 2000);

    return () => clearTimeout(timer);
  }, [isDirty, saveState, saveContent]);

  // Loading state
  if (loadState === 'loading') {
    return (
      <div className="story-view story-view--loading">
        <div className="loading-spinner" />
        <p>{t('gallery.story.loading', 'Loading story...')}</p>
      </div>
    );
  }

  // Error state
  if (loadState === 'error') {
    return (
      <div className="story-view story-view--error">
        <p>{t('gallery.story.error', 'Failed to load story')}</p>
        {errorMessage && <p className="error-message">{errorMessage}</p>}
        <button onClick={() => loadContent()} className="btn btn-secondary">
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  // Not found - show create option
  if (loadState === 'not-found') {
    return (
      <div className="story-view story-view--empty">
        <div className="story-view__empty-state">
          <h3>{t('gallery.story.noContent', 'No story yet')}</h3>
          <p>
            {t(
              'gallery.story.createDescription',
              'Create a story to add narrative to your album.',
            )}
          </p>
          {canEdit && (
            <button
              onClick={() => createInitialContent()}
              className="btn btn-primary"
            >
              {t('gallery.story.create', 'Create Story')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // No document yet (shouldn't happen after loading)
  if (!document) {
    return null;
  }

  const handleBlockMove = (fromIndex: number, toIndex: number) => {
    const block = document.blocks[fromIndex];
    if (block) {
      moveBlock(block.id, toIndex);
    }
  };

  return (
    <div className="story-view">
      {/* Save status indicator */}
      <div className="story-view__status">
        {saveState === 'saving' && (
          <span className="status-saving">
            {t('gallery.story.saving', 'Saving...')}
          </span>
        )}
        {saveState === 'saved' && (
          <span className="status-saved">
            {t('gallery.story.saved', 'Saved')}
          </span>
        )}
        {saveState === 'error' && (
          <span className="status-error">
            {t('gallery.story.saveError', 'Save failed')}
          </span>
        )}
        {saveState === 'conflict' && (
          <span className="status-conflict">
            {t('gallery.story.conflict', 'Conflict detected')}
          </span>
        )}
      </div>

      <ContentEditor
        blocks={document.blocks}
        onBlockUpdate={updateBlock}
        onBlockAdd={addBlock}
        onBlockRemove={removeBlock}
        onBlockMove={handleBlockMove}
        albumId={albumId}
        className="story-view__editor"
      />
    </div>
  );
}

/**
 * Story view wrapper that provides the AlbumContentProvider context
 */
function StoryView({
  albumId,
  currentEpochId,
}: {
  albumId: string;
  currentEpochId: number | null;
}) {
  const { t } = useTranslation();

  // No epoch key available yet
  if (currentEpochId === null) {
    return (
      <div className="story-view story-view--no-key">
        <div className="loading-spinner" />
        <p>
          {t(
            'gallery.story.loadingKeys',
            'Loading encryption keys...',
          )}
        </p>
      </div>
    );
  }

  return (
    <AlbumContentProvider albumId={albumId} epochId={currentEpochId}>
      <StoryViewContent />
    </AlbumContentProvider>
  );
}

interface GalleryProps {
  albumId: string;
  albumName?: string | undefined;
  onAlbumDeleted?: () => void;
  onDeleteAlbum?: (albumId: string) => Promise<boolean>;
  onRenameAlbum?: (albumId: string, newName: string) => Promise<boolean>;
}

/**
 * Convert photos with geolocation to GeoFeatures for the map
 * Filters out photos without valid GPS coordinates (null, undefined, or invalid)
 */
function photosToGeoFeatures(photos: PhotoMeta[]): GeoFeature[] {
  return photos
    .filter(
      (p) =>
        p.lat != null &&
        p.lng != null &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng),
    )
    .map((p) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [p.lng!, p.lat!] as [number, number],
      },
      properties: {
        id: p.id,
      },
    }));
}

/**
 * Gallery View Component
 * Displays photos in a virtualized grid or map view with upload capability
 */
export function Gallery({
  albumId,
  albumName,
  onAlbumDeleted,
  onDeleteAlbum,
  onRenameAlbum,
}: GalleryProps) {
  const [showMembers, setShowMembers] = useState(false);
  const [showShareLinks, setShowShareLinks] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showExpirationDialog, setShowExpirationDialog] = useState(false);
  const [expirationAlbum, setExpirationAlbum] = useState<ApiAlbum | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<GalleryViewMode>('justified');
  const [searchQuery, setSearchQuery] = useState('');

  // State for bulk photo delete dialog
  const [bulkDeletePhotos, setBulkDeletePhotos] = useState<PhotoMeta[]>([]);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);

  const {
    photos,
    isLoading,
    error,
    refetch: reloadPhotos,
  } = usePhotoList(albumId, searchQuery);
  const { epochKeys, isLoading: epochKeysLoading } = useAlbumEpochKeys(albumId);

  // Get the current (most recent) epoch ID for story content
  const currentEpochId = useMemo(() => {
    if (epochKeysLoading || epochKeys.size === 0) return null;
    // Return the highest epoch ID (most recent)
    return Math.max(...epochKeys.keys());
  }, [epochKeys, epochKeysLoading]);

  const { currentUserRole, isOwner, canEdit } = useAlbumMembers(albumId);
  const photoActions = usePhotoActions();
  const albumDownload = useAlbumDownload();

  // Sort photos by createdAt descending to match display order
  // This ensures lightbox navigation follows the visual order
  const sortedPhotos = useMemo(
    () =>
      [...photos].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [photos],
  );

  const lightbox = useLightbox(sortedPhotos);
  const { syncAlbum } = useSync();

  // Selection state for batch operations (lifted up from photo grids)
  const selection = useSelection();

  // Register this album for background auto-sync
  useAutoSync(albumId);

  // Track if initial sync has been attempted
  const initialSyncDone = useRef(false);

  // Perform initial sync when epoch keys become available
  useEffect(() => {
    // Only sync once per mount and when we have epoch keys
    if (initialSyncDone.current || epochKeysLoading || epochKeys.size === 0) {
      return;
    }

    // Get the first (most recent) epoch key for initial sync
    const entries = Array.from(epochKeys.entries());
    if (entries.length === 0) {
      return;
    }

    // Use the most recent epoch (highest epochId)
    const [epochId, readKey] = entries.reduce((max, curr) =>
      curr[0] > max[0] ? curr : max,
    );

    initialSyncDone.current = true;
    log.info(`Initial sync for album ${albumId} with epoch ${epochId}`);

    syncAlbum(albumId, readKey)
      .then(() => {
        log.info(`Initial sync complete for album ${albumId}`);
        // Reload photos after sync completes
        reloadPhotos();
      })
      .catch((err) => {
        log.error(`Initial sync failed for album ${albumId}:`, err);
      });
  }, [albumId, epochKeys, epochKeysLoading, syncAlbum, reloadPhotos]);

  // Note: sync-complete event handling is now managed by SyncCoordinator
  // The PhotoStore is updated automatically, and usePhotoList subscribes to those changes

  // Convert photos to GeoFeatures for map view
  const geoFeatures = useMemo(() => photosToGeoFeatures(photos), [photos]);

  // Count geotagged photos
  const geotaggedCount = geoFeatures.length;

  // Handle photo click from map
  const handleMapPhotoClick = useCallback(
    (photoId: string) => {
      const index = photos.findIndex((p) => p.id === photoId);
      if (index >= 0) {
        lightbox.open(index);
      }
    },
    [photos, lightbox],
  );

  // Handle cluster click from map - open lightbox with first photo
  const handleMapClusterClick = useCallback(
    (photoIds: string[]) => {
      if (photoIds.length > 0) {
        const index = photos.findIndex((p) => p.id === photoIds[0]);
        if (index >= 0) {
          lightbox.open(index);
        }
      }
    },
    [photos, lightbox],
  );

  // Handle album deletion
  const handleDeleteAlbum = useCallback(() => {
    setDeleteError(null);
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!onDeleteAlbum) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const success = await onDeleteAlbum(albumId);
      if (success) {
        setShowDeleteDialog(false);
        onAlbumDeleted?.();
      } else {
        setDeleteError('Failed to delete album. Please try again.');
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete album';
      setDeleteError(message);
    } finally {
      setIsDeleting(false);
    }
  }, [albumId, onDeleteAlbum, onAlbumDeleted]);

  const handleCancelDelete = useCallback(() => {
    if (!isDeleting) {
      setShowDeleteDialog(false);
      setDeleteError(null);
    }
  }, [isDeleting]);

  // Handle bulk photo delete from header
  const handleBulkDeleteClick = useCallback(() => {
    const selectedPhotos = photos.filter((p) =>
      selection.selectedIds.has(p.id),
    );
    if (selectedPhotos.length > 0) {
      setBulkDeletePhotos(selectedPhotos);
      setShowBulkDeleteDialog(true);
      setBulkDeleteError(null);
    }
  }, [photos, selection.selectedIds]);

  // Confirm bulk delete
  const handleConfirmBulkDelete = useCallback(async () => {
    if (bulkDeletePhotos.length === 0) return;

    setBulkDeleteError(null);

    try {
      const result = await photoActions.deletePhotos(
        bulkDeletePhotos.map((p) => p.id),
        albumId,
      );

      if (result.failureCount > 0) {
        // Some photos failed to delete
        setBulkDeleteError(
          `Failed to delete ${result.failureCount} of ${bulkDeletePhotos.length} photos. ${result.errors.join(', ')}`,
        );
      } else {
        // All photos deleted successfully
        setShowBulkDeleteDialog(false);
        setBulkDeletePhotos([]);
        selection.exitSelectionMode();
        reloadPhotos();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete photos';
      setBulkDeleteError(message);
    }
  }, [bulkDeletePhotos, photoActions, albumId, selection, reloadPhotos]);

  // Cancel bulk delete
  const handleCancelBulkDelete = useCallback(() => {
    if (!photoActions.isDeleting) {
      setShowBulkDeleteDialog(false);
      setBulkDeletePhotos([]);
      setBulkDeleteError(null);
    }
  }, [photoActions.isDeleting]);

  // Callback when bulk delete completes in photo grid
  const handleBulkDeleteComplete = useCallback(() => {
    setShowBulkDeleteDialog(false);
    setBulkDeletePhotos([]);
    selection.exitSelectionMode();
    reloadPhotos();
  }, [selection, reloadPhotos]);

  // Select all photos - wrapper for header
  const handleSelectAll = useCallback(() => {
    selection.selectAll(photos.map((p) => p.id));
  }, [photos, selection]);

  // Handle download all photos
  const handleDownloadAll = useCallback(() => {
    if (photos.length === 0) return;
    void albumDownload.startDownload(albumId, albumName ?? 'Album', photos);
  }, [photos, albumId, albumName, albumDownload]);

  // Handle download selected photos
  const handleDownloadSelected = useCallback(() => {
    const selectedPhotos = photos.filter((p) => selection.selectedIds.has(p.id));
    if (selectedPhotos.length === 0) return;
    void albumDownload.startDownload(albumId, albumName ?? 'Album', selectedPhotos);
  }, [photos, selection.selectedIds, albumId, albumName, albumDownload]);

  // Handle album rename
  const handleRenameAlbum = useCallback(() => {
    setRenameError(null);
    setShowRenameDialog(true);
  }, []);

  const handleConfirmRename = useCallback(
    async (newName: string) => {
      if (!onRenameAlbum) return;

      setIsRenaming(true);
      setRenameError(null);

      try {
        const success = await onRenameAlbum(albumId, newName);
        if (success) {
          setShowRenameDialog(false);
        } else {
          setRenameError('Failed to rename album. Please try again.');
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to rename album';
        setRenameError(message);
      } finally {
        setIsRenaming(false);
      }
    },
    [albumId, onRenameAlbum],
  );

  const handleCancelRename = useCallback(() => {
    if (!isRenaming) {
      setShowRenameDialog(false);
      setRenameError(null);
    }
  }, [isRenaming]);

  // Handle expiration settings
  const handleExpiration = useCallback(async () => {
    try {
      const api = getApi();
      const album = await api.getAlbum(albumId);
      setExpirationAlbum(album);
      setShowExpirationDialog(true);
    } catch (err) {
      log.error('Failed to load album for expiration settings:', err);
    }
  }, [albumId]);

  const handleExpirationUpdate = useCallback(async () => {
    try {
      const api = getApi();
      const album = await api.getAlbum(albumId);
      setExpirationAlbum(album);
    } catch (err) {
      log.error('Failed to refresh album after expiration update:', err);
    }
  }, [albumId]);

  const handleCloseExpiration = useCallback(() => {
    setShowExpirationDialog(false);
    setExpirationAlbum(null);
  }, []);

  // Compute preload queue for lightbox
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];

    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;
    const PRELOAD_COUNT = 2;

    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = sortedPhotos[currentIdx - offset];
      const nextPhoto = sortedPhotos[currentIdx + offset];
      if (prevPhoto) queue.push(prevPhoto);
      if (nextPhoto) queue.push(nextPhoto);
    }

    return queue;
  }, [lightbox.isOpen, lightbox.currentIndex, lightbox.currentPhoto, photos]);

  // Get epoch read key for current lightbox photo
  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  const { t } = useTranslation();

  // Loading state
  if (isLoading) {
    return (
      <div className="gallery" data-testid="gallery">
        <div className="gallery-loading">
          <div className="loading-spinner" />
          <p>{t('gallery.loading')}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="gallery" data-testid="gallery">
        <div className="gallery-error">
          <p>
            {t('gallery.error.loadFailed')}: {error.message}
          </p>
        </div>
      </div>
    );
  }

  return (
    <AlbumPermissionsProvider role={currentUserRole ?? 'viewer'}>
      <UploadProvider>
        <SyncCoordinatorProvider>
          <div
            className={`gallery ${selection.isSelectionMode ? 'selection-mode-active' : ''}`}
            data-testid="gallery"
          >
            <GalleryHeader
              albumId={albumId}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              geotaggedCount={geotaggedCount}
              onShowMembers={() => setShowMembers(true)}
              onShowShareLinks={() => setShowShareLinks(true)}
              onRenameAlbum={onRenameAlbum ? handleRenameAlbum : undefined}
              onDeleteAlbum={onDeleteAlbum ? handleDeleteAlbum : undefined}
              onExpiration={handleExpiration}
              onDownloadAll={handleDownloadAll}
              selection={{
                isSelectionMode: selection.isSelectionMode,
                selectedCount: selection.selectedCount,
              }}
              selectionActions={{
                toggleSelectionMode: selection.toggleSelectionMode,
                selectAll: handleSelectAll,
                clearSelection: selection.clearSelection,
                onBulkDelete: handleBulkDeleteClick,
              }}
            />

            {/* Gallery Content - Wrapped in DropZone for drag-and-drop upload */}
            <DropZone
              albumId={albumId}
              className="gallery-content"
              disabled={!canEdit}
            >
              {viewMode === 'justified' ? (
                <PhotoGrid
                  albumId={albumId}
                  photos={photos}
                  isLoading={isLoading}
                  error={error}
                  refetch={reloadPhotos}
                  selection={selection}
                  onPhotosDeleted={handleBulkDeleteComplete}
                />
              ) : viewMode === 'grid' ? (
                <SquarePhotoGrid
                  albumId={albumId}
                  photos={photos}
                  isLoading={isLoading}
                  error={error}
                  refetch={reloadPhotos}
                  selection={selection}
                  onPhotosDeleted={handleBulkDeleteComplete}
                />
              ) : viewMode === 'mosaic' ? (
                <MosaicPhotoGrid
                  albumId={albumId}
                  photos={photos}
                  isLoading={isLoading}
                  error={error}
                  refetch={reloadPhotos}
                  selection={selection}
                  onPhotosDeleted={handleBulkDeleteComplete}
                />
              ) : viewMode === 'story' ? (
                <StoryView
                  albumId={albumId}
                  currentEpochId={currentEpochId}
                />
              ) : (
                <MapView
                  albumId={albumId}
                  points={geoFeatures}
                  photos={photos}
                  onPhotoClick={handleMapPhotoClick}
                  onClusterClick={handleMapClusterClick}
                />
              )}
            </DropZone>

            {/* Member List Modal */}
            <MemberList
              albumId={albumId}
              isOpen={showMembers}
              onClose={() => setShowMembers(false)}
            />

            {/* Share Links Panel (owners only) */}
            {isOwner && (
              <ShareLinksPanel
                albumId={albumId}
                isOpen={showShareLinks}
                onClose={() => setShowShareLinks(false)}
                isOwner={isOwner}
              />
            )}

            {/* Photo Lightbox - Only used by MapView; justified/mosaic grids manage their own */}
            {viewMode === 'map' &&
              lightbox.isOpen &&
              lightbox.currentPhoto &&
              currentEpochReadKey && (
                <PhotoLightbox
                  photo={lightbox.currentPhoto}
                  epochReadKey={currentEpochReadKey}
                  onClose={lightbox.close}
                  {...(lightbox.hasNext && { onNext: lightbox.next })}
                  {...(lightbox.hasPrevious && {
                    onPrevious: lightbox.previous,
                  })}
                  hasNext={lightbox.hasNext}
                  hasPrevious={lightbox.hasPrevious}
                  preloadQueue={preloadQueue}
                />
              )}

            {/* Delete Album Confirmation Dialog */}
            {showDeleteDialog && (
              <DeleteAlbumDialog
                albumName={albumName ?? `Album ${albumId.slice(0, 8)}`}
                photoCount={photos.length}
                isDeleting={isDeleting}
                onConfirm={handleConfirmDelete}
                onCancel={handleCancelDelete}
                error={deleteError}
              />
            )}

            {/* Rename Album Dialog */}
            <RenameAlbumDialog
              isOpen={showRenameDialog}
              onClose={handleCancelRename}
              onRename={handleConfirmRename}
              isRenaming={isRenaming}
              error={renameError}
              currentName={albumName ?? `Album ${albumId.slice(0, 8)}`}
            />

            {/* Expiration Settings Dialog */}
            {showExpirationDialog && expirationAlbum && (
              <Dialog
                isOpen={showExpirationDialog}
                onClose={handleCloseExpiration}
                title={t('album.menu.expirationSettings')}
                testId="expiration-dialog"
              >
                <AlbumExpirationSettings
                  album={expirationAlbum}
                  onUpdate={handleExpirationUpdate}
                />
              </Dialog>
            )}

            {/* Upload Error Toast */}
            <UploadErrorToast />

            {/* Download Progress Overlay */}
            {albumDownload.isDownloading && albumDownload.progress && (
              <DownloadProgressOverlay
                progress={albumDownload.progress}
                onCancel={albumDownload.cancel}
              />
            )}

            {/* Bulk Delete Photo Confirmation Dialog */}
            {showBulkDeleteDialog && bulkDeletePhotos.length > 0 && (
              <DeletePhotoDialog
                photos={bulkDeletePhotos}
                isDeleting={photoActions.isDeleting}
                onConfirm={handleConfirmBulkDelete}
                onCancel={handleCancelBulkDelete}
                error={bulkDeleteError}
              />
            )}

            {/* Selection Action Bar - floating bottom bar when in selection mode */}
            <SelectionActionBar
              selectedCount={selection.selectedCount}
              isSelectionMode={selection.isSelectionMode}
              onSelectAll={handleSelectAll}
              onClearSelection={selection.clearSelection}
              onExitSelectionMode={selection.exitSelectionMode}
              onDeleteSelected={handleBulkDeleteClick}
              onDownloadSelected={handleDownloadSelected}
              totalPhotos={photos.length}
            />
          </div>
        </SyncCoordinatorProvider>
      </UploadProvider>
    </AlbumPermissionsProvider>
  );
}
