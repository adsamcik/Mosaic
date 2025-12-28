import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlbumPermissionsProvider } from '../../contexts/AlbumPermissionsContext';
import { UploadProvider } from '../../contexts/UploadContext';
import { useAutoSync } from '../../contexts/SyncContext';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { useAlbumMembers } from '../../hooks/useAlbumMembers';
import { usePhotos } from '../../hooks/usePhotos';
import { useSync } from '../../hooks/useSync';
import { createLogger } from '../../lib/logger';
import type { GeoFeature, PhotoMeta } from '../../workers/types';
import { MemberList } from '../Members/MemberList';
import { ShareLinksPanel } from '../ShareLinks/ShareLinksPanel';
import { DropZone } from '../Upload/DropZone';
import { UploadErrorToast } from '../Upload/UploadErrorToast';
import { GalleryHeader } from './GalleryHeader';
import { JustifiedPhotoGrid } from './JustifiedPhotoGrid';
import { MapView } from './MapView';
import { PhotoGrid } from './PhotoGrid';
import { PhotoLightbox } from './PhotoLightbox';

const log = createLogger('Gallery');

/** View mode for the gallery */
export type GalleryViewMode = 'grid' | 'justified' | 'map';

interface GalleryProps {
  albumId: string;
}

/**
 * Convert photos with geolocation to GeoFeatures for the map
 */
function photosToGeoFeatures(photos: PhotoMeta[]): GeoFeature[] {
  return photos
    .filter((p) => p.lat !== undefined && p.lng !== undefined)
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
export function Gallery({ albumId }: GalleryProps) {
  const [showMembers, setShowMembers] = useState(false);
  const [showShareLinks, setShowShareLinks] = useState(false);
  const [viewMode, setViewMode] = useState<GalleryViewMode>('justified');
  const [searchQuery, setSearchQuery] = useState('');

  const { photos, isLoading, error, refetch: reloadPhotos } = usePhotos(albumId, searchQuery);
  const { epochKeys, isLoading: epochKeysLoading } = useAlbumEpochKeys(albumId);
  const { currentUserRole, isOwner, canEdit } = useAlbumMembers(albumId);
  const lightbox = useLightbox(photos);
  const { syncAlbum } = useSync();
  
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
      curr[0] > max[0] ? curr : max
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
    [photos, lightbox]
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
    [photos, lightbox]
  );

  // Compute preload queue for lightbox
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];

    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;
    const PRELOAD_COUNT = 2;

    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = photos[currentIdx - offset];
      const nextPhoto = photos[currentIdx + offset];
      if (prevPhoto) queue.push(prevPhoto);
      if (nextPhoto) queue.push(nextPhoto);
    }

    return queue;
  }, [lightbox.isOpen, lightbox.currentIndex, lightbox.currentPhoto, photos]);

  // Get epoch read key for current lightbox photo
  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  // Loading state
  if (isLoading) {
    return (
      <div className="gallery" data-testid="gallery">
        <div className="gallery-loading">
          <div className="loading-spinner" />
          <p>Loading photos...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="gallery" data-testid="gallery">
        <div className="gallery-error">
          <p>Failed to load photos: {error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <AlbumPermissionsProvider role={currentUserRole ?? 'viewer'}>
    <UploadProvider>
      <div className="gallery" data-testid="gallery">
        <GalleryHeader
          albumId={albumId}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          geotaggedCount={geotaggedCount}
          onShowMembers={() => setShowMembers(true)}
          onShowShareLinks={() => setShowShareLinks(true)}
        />

      {/* Gallery Content - Wrapped in DropZone for drag-and-drop upload */}
      <DropZone albumId={albumId} className="gallery-content" disabled={!canEdit}>
        {viewMode === 'justified' ? (
          <JustifiedPhotoGrid albumId={albumId} />
        ) : viewMode === 'grid' ? (
          <PhotoGrid albumId={albumId} />
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

      {/* Photo Lightbox */}
      {lightbox.isOpen && lightbox.currentPhoto && currentEpochReadKey && (
        <PhotoLightbox
          photo={lightbox.currentPhoto}
          epochReadKey={currentEpochReadKey}
          onClose={lightbox.close}
          {...(lightbox.hasNext && { onNext: lightbox.next })}
          {...(lightbox.hasPrevious && { onPrevious: lightbox.previous })}
          hasNext={lightbox.hasNext}
          hasPrevious={lightbox.hasPrevious}
          preloadQueue={preloadQueue}
        />
      )}

      {/* Upload Error Toast */}
      <UploadErrorToast />
      </div>
    </UploadProvider>
    </AlbumPermissionsProvider>
  );
}
