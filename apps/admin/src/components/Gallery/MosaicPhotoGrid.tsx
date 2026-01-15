import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import { useAnimatedItems } from '../../hooks/useAnimatedItems';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoDelete } from '../../hooks/usePhotoDelete';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import { computeMosaicLayout, type MosaicItem } from '../../lib/mosaic-layout';
import { usePhotoStore, type PhotoItem } from '../../stores/photo-store';
import '../../styles/upload.css';
import type { PhotoMeta } from '../../workers/types';
import { AnimatedTile } from './AnimatedTile';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { JustifiedPhotoThumbnail } from './JustifiedPhotoThumbnail';
import { MosaicTile } from './MosaicTile';
import { PhotoLightbox } from './PhotoLightbox';

/** Gap between photos in pixels */
const PHOTO_GAP = 4;

/** Target row height in pixels */
const TARGET_ROW_HEIGHT = 220;

/** Height of the date header in pixels */
const HEADER_HEIGHT = 44; 

/** Number of photos to preload */
const PRELOAD_COUNT = 2;

interface MosaicPhotoGridProps {
  albumId: string;
  /** Photos to display (passed from Gallery) */
  photos: PhotoMeta[];
  /** Whether photos are loading */
  isLoading: boolean;
  /** Error if photo loading failed */
  error: Error | null;
  /** Function to trigger a photo refetch */
  refetch: () => void;
  onPhotosDeleted?: () => void;
  selection?: UseSelectionReturn;
}

// Flat item for virtualization
type VirtualItem = 
  | { type: 'header'; date: string; id: string; height: number }
  | { type: 'mosaic-row'; items: MosaicItem[]; height: number; id: string; top: number };


function formatDateHeader(dateString: string): string {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Unknown Date';
    
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return new Intl.DateTimeFormat('en-US', { 
        weekday: 'long', 
        month: 'short', 
        day: 'numeric',
        year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
    }).format(date);
}

function groupPhotosByDate(photos: PhotoMeta[]) {
    const groups: Record<string, PhotoMeta[]> = {};
    const sorted = [...photos].sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    for (const photo of sorted) {
        const dateKey = new Date(photo.createdAt).toDateString(); 
        if (!groups[dateKey]) {
            groups[dateKey] = [];
        }
        groups[dateKey].push(photo);
    }
    
    return Object.entries(groups).sort((a, b) => 
        new Date(b[0]).getTime() - new Date(a[0]).getTime()
    );
}

export function MosaicPhotoGrid({ albumId, photos, isLoading, error, refetch, onPhotosDeleted, selection }: MosaicPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  
  // Resize observer
  useEffect(() => {
    const node = parentRef.current;
    if (!node) return;
    
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);
  
  // Sort photos by createdAt descending to match display order
  // This ensures lightbox navigation follows the visual order
  const sortedPhotos = useMemo(() => 
    [...photos].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    [photos]
  );

  // Animation system for photo tiles
  const {
    animatedItems,
    handleExitComplete,
    getStaggerDelay,
    hasBeenSeen,
    isInitialLoad,
  } = useAnimatedItems(sortedPhotos, {
    getKey: (photo) => photo.id,
    onRemoveComplete: () => {
      // Photo removed from animation system
    },
  });

  // Create animation lookup map for quick access during render
  const animationLookup = useMemo(() => {
    const lookup = new Map<string, { isExiting: boolean; staggerDelay: number; hasBeenSeen: boolean }>();
    for (const item of animatedItems) {
      lookup.set(item.key, {
        isExiting: item.isExiting,
        staggerDelay: getStaggerDelay(item.key),
        hasBeenSeen: hasBeenSeen(item.key),
      });
    }
    return lookup;
  }, [animatedItems, getStaggerDelay, hasBeenSeen]);
  
  const lightbox = useLightbox(sortedPhotos);
  const permissions = useAlbumPermissions();
  
  // Get photo items from store for status checking
  const getPhotoItem = usePhotoStore((state) => state.getPhoto);
  
  /**
   * Check if a photo is pending/syncing by looking it up in the PhotoStore.
   * Returns the PhotoItem if pending/syncing, undefined otherwise.
   */
  const getPendingPhotoItem = useCallback((photo: PhotoMeta): PhotoItem | undefined => {
    const item = getPhotoItem(albumId, photo.assetId);
    if (item && (item.status === 'pending' || item.status === 'syncing')) {
      return item;
    }
    return undefined;
  }, [getPhotoItem, albumId]);

  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedIds = selection?.selectedIds ?? new Set<string>();

  // Photo delete workflow
  const {
    deleteTarget,
    deleteThumbnailUrl,
    isDeleting,
    error: deleteError,
    handleDeletePhoto,
    handleDeleteFromLightbox,
    handleConfirmDelete,
    handleCancelDelete,
  } = usePhotoDelete({
    albumId,
    lightbox,
    selection,
    refetch,
    onPhotosDeleted,
  });

  // Compute Layout Items (Headers + Mosaic Blocks)
  // Note: Virtualizing absolute positioned items is tricky if we want to use `useVirtualizer` which expects a flat list of rows.
  // We can flatten the structure: Item = Header | MosaicRow (where MosaicRow contains multiple absolutely positioned tiles relative to itself).
  // `computeMosaicLayout` returns items with absolute positions. We can group them by their implicit "rows" based on `top` coordinate.
  
  const virtualRows = useMemo(() => {
    if (containerWidth <= 0 || photos.length === 0) return [];
    
    const grouped = groupPhotosByDate(photos);
    const rows: VirtualItem[] = [];
    
    for (const [dateString, groupPhotos] of grouped) {
      rows.push({
        type: 'header',
        date: formatDateHeader(dateString),
        id: `header-${dateString}`,
        height: HEADER_HEIGHT
      });

      const mosaicRows = computeMosaicLayout(groupPhotos, {
        containerWidth,
        gap: PHOTO_GAP,
        targetRowHeight: TARGET_ROW_HEIGHT
      });

      // Now we have explicit rows
      for (const row of mosaicRows) {
        const rowTop = row.top || 0;
        
        const itemsRelative = row.items.map(it => ({
             ...it,
             rect: { ...it.rect, top: it.rect.top - rowTop }
        }));

        rows.push({
          type: 'mosaic-row',
          items: itemsRelative,
          height: row.height + PHOTO_GAP, 
          id: `row-${dateString}-${rowTop}`,
          top: 0 
        });
      }
    }
    return rows;
  }, [photos, containerWidth]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => virtualRows[i]?.height ?? 0,
    overscan: 3, // Number of extra rows to render above/below viewport
  });

  // Handlers (copied/adapted from PhotoGrid)
  const handlePhotoClick = useCallback(
    (photo: PhotoMeta) => {
      if (!isSelectionMode) {
        // Find index in the sorted photos array (matches display order)
        const index = sortedPhotos.findIndex((p) => p.id === photo.id);
        if (index >= 0) lightbox.open(index);
      }
    },
    [isSelectionMode, lightbox, sortedPhotos]
  );

  const handleSelectionChange = useCallback((photoId: string, selected: boolean) => {
    if (selection) {
      if (selected) selection.selectPhoto(photoId);
      else selection.deselectPhoto(photoId);
    }
  }, [selection]);

  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];
    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prev = sortedPhotos[currentIdx - offset];
      const next = sortedPhotos[currentIdx + offset];
      if (prev) queue.push(prev);
      if (next) queue.push(next);
    }
    return queue;
  }, [lightbox.isOpen, lightbox.currentIndex, lightbox.currentPhoto, sortedPhotos]);

  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  if (isLoading || keysLoading) {
    return (
      <div className="photo-grid-loading">
        <div className="loading-spinner" />
        <p>Loading photos...</p>
      </div>
    );
  }

  if (error) return <div className="photo-grid-error">{error.message}</div>;

  return (
    <>
      <div
        ref={parentRef}
        className={`photo-grid-container ${isSelectionMode ? 'selection-mode' : ''}`}
        style={{ height: '100%', overflowY: 'auto' }}
        data-testid="mosaic-photo-grid"
      >
        <div
            style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
            }}
        >
            {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = virtualRows[virtualRow.index];
                if (!item) return null;
                
                if (item.type === 'header') {
                    return (
                        <div
                            key={item.id}
                            className="photo-grid-header"
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: `${item.height}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                                paddingLeft: '16px',
                                display: 'flex',
                                alignItems: 'center',
                                fontWeight: 600,
                                color: 'var(--text-secondary)',
                                zIndex: 1
                            }}
                        >
                            {item.date}
                        </div>
                    );
                }

                // Mosaic Row
                if (item.type !== 'mosaic-row') return null;

                return (
                    <div
                        key={item.id}
                        className="mosaic-row"
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${item.height}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                        }}
                    >
                        {item.items.map(mosaicItem => {
                           const photo = photos.find(p => p.id === mosaicItem.photoId);
                           if (!photo) return null;

                           // Check if this photo is pending/syncing in the PhotoStore
                           const pendingItem = getPendingPhotoItem(photo);
                           
                           if (pendingItem) {
                               // Render pending photo with progress overlay
                               const progress = pendingItem.uploadProgress ?? 0;
                               const isUploading = progress > 0 && progress < 1;
                               const statusText = pendingItem.error 
                                 ? 'Error' 
                                 : isUploading 
                                   ? 'Uploading...' 
                                   : pendingItem.status === 'syncing'
                                     ? 'Finalizing...'
                                     : 'Queued';
                               const displayProgress = isUploading ? 20 + (progress * 70) : (pendingItem.status === 'syncing' ? 95 : 0);
                               
                               return (
                                   <div 
                                     key={photo.id}
                                     className="mosaic-tile"
                                     style={{
                                        position: 'absolute',
                                        top: mosaicItem.rect.top,
                                        left: mosaicItem.rect.left,
                                        width: mosaicItem.rect.width,
                                        height: mosaicItem.rect.height,
                                     }}
                                   >
                                       <div className="photo-thumbnail photo-thumbnail-pending" data-testid="pending-photo-thumbnail">
                                         <div className="photo-content">
                                           {pendingItem.localBlobUrl && (
                                             <img
                                               src={pendingItem.localBlobUrl}
                                               alt={photo.filename}
                                               className="photo-image"
                                               style={{ opacity: 0.7, width: '100%', height: '100%', objectFit: 'cover' }}
                                             />
                                           )}
                                           <div className="upload-overlay">
                                             {displayProgress > 0 ? (
                                               <div className="upload-progress-container">
                                                 <div 
                                                   className="upload-progress-bar"
                                                   style={{ width: `${displayProgress}%` }}
                                                 />
                                               </div>
                                             ) : null}
                                             <span className="upload-status">{statusText}</span>
                                           </div>
                                         </div>
                                       </div>
                                   </div>
                               );
                           }

                           const epochKey = epochKeys.get(photo.epochId);
                           const isSelected = selectedIds.has(photo.id);

                           // Get animation state for this photo
                           const animState = animationLookup.get(photo.id);
                           const skipAnimation = isInitialLoad || !animState;

                           return (
                               <AnimatedTile
                                   key={photo.id}
                                   itemKey={photo.id}
                                   skipAnimation={skipAnimation}
                                   isExiting={animState?.isExiting ?? false}
                                   onExitComplete={() => handleExitComplete(photo.id)}
                                   staggerDelay={animState?.staggerDelay ?? 0}
                                   hasBeenSeen={animState?.hasBeenSeen ?? false}
                                   style={{
                                       position: 'absolute',
                                       top: mosaicItem.rect.top,
                                       left: mosaicItem.rect.left,
                                       width: mosaicItem.rect.width,
                                       height: mosaicItem.rect.height,
                                   }}
                               >
                                   <MosaicTile 
                                       item={mosaicItem}
                                       photo={photo}
                                       onClick={() => handlePhotoClick(photo)}
                                        renderThumbnail={({ photo, width, height, onClick }) => (
                                            <div style={{ width: '100%', height: '100%' }}>
                                                <JustifiedPhotoThumbnail
                                                    photo={photo}
                                                    epochReadKey={epochKey}
                                                    isSelected={isSelected}
                                                    selectionMode={isSelectionMode}
                                                    onSelectionChange={(selected) => handleSelectionChange(photo.id, selected)}
                                                    onClick={() => onClick?.()}
                                                    width={width}
                                                    height={height}
                                                    onDelete={(url) => handleDeletePhoto(photo, url)}
                                                />
                                            </div>
                                        )}
                                        skipPositioning
                                   />
                               </AnimatedTile>
                           );
                        })}
                    </div>
                );
            })}
        </div>
      </div>

       {/* Lightbox & Dialogs */}
       {lightbox.isOpen && lightbox.currentPhoto && currentEpochReadKey && (
        <PhotoLightbox
          photo={lightbox.currentPhoto}
          epochReadKey={currentEpochReadKey}
          onClose={lightbox.close}
          onNext={lightbox.next}
          onPrevious={lightbox.previous}
          hasNext={lightbox.hasNext}
          hasPrevious={lightbox.hasPrevious}
          preloadQueue={preloadQueue}
          {...(permissions.canDelete && { onDelete: handleDeleteFromLightbox })}
        />
      )}
       {deleteTarget && deleteTarget.length > 0 && (
        <DeletePhotoDialog
          photos={deleteTarget}
          thumbnailUrl={deleteThumbnailUrl}
          isDeleting={isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
          error={deleteError}
        />
      )}
    </>
  );
}
