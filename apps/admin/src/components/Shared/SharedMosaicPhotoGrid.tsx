import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import { computeMosaicLayout, type MosaicItem } from '../../lib/mosaic-layout';
import type { PhotoMeta } from '../../workers/types';
import { MosaicTile } from '../Gallery/MosaicTile';
import { SharedPhotoLightbox } from './SharedPhotoLightbox';
import { SharedPhotoThumbnail } from './SharedPhotoThumbnail';

/** Gap between photos in pixels */
const PHOTO_GAP = 4;

/** Target row height in pixels */
const TARGET_ROW_HEIGHT = 220;

/** Height of the date header in pixels */
const HEADER_HEIGHT = 44; 

/** Number of photos to preload */
const PRELOAD_COUNT = 2;

interface SharedMosaicPhotoGridProps {
  photos: PhotoMeta[];
  linkId: string;
  accessTier: AccessTierType;
  getTierKey: (epochId: number, tier: AccessTierType) => Uint8Array | undefined;
  isLoadingKeys?: boolean;
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

export function SharedMosaicPhotoGrid({ 
  photos,
  linkId,
  accessTier, 
  getTierKey, 
  isLoadingKeys = false 
}: SharedMosaicPhotoGridProps) {
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

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Compute Layout Items
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

      const mosaicItems = computeMosaicLayout(groupPhotos, {
        containerWidth,
        gap: PHOTO_GAP,
        targetRowHeight: TARGET_ROW_HEIGHT
      });

      const byTop = new Map<number, MosaicItem[]>();
      mosaicItems.forEach(item => {
        const t = Math.round(item.rect.top);
        if (!byTop.has(t)) byTop.set(t, []);
        byTop.get(t)!.push(item);
      });

      const sortedTops = Array.from(byTop.keys()).sort((a, b) => a - b);
      
      for (const top of sortedTops) {
        const items = byTop.get(top)!;
        let maxBottom = 0;
        items.forEach(it => {
            const bottom = it.rect.top + it.rect.height;
            if (bottom > maxBottom) maxBottom = bottom;
        });
        
        const rowHeight = maxBottom - top;
        
        rows.push({
          type: 'mosaic-row',
          items: items.map(it => ({
            ...it,
            rect: { ...it.rect, top: it.rect.top - top } 
          })),
          height: rowHeight + PHOTO_GAP, 
          id: `row-${dateString}-${top}`,
          top: 0 
        });
      }
    }
    return rows;
  }, [photos, containerWidth]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => virtualRows[i]?.height ?? TARGET_ROW_HEIGHT,
    overscan: 500,
  });

  const handlePhotoClick = useCallback((photo: PhotoMeta) => {
    const index = photos.findIndex(p => p.id === photo.id);
    if (index >= 0) setLightboxIndex(index);
  }, [photos]);

  const currentPhoto = lightboxIndex !== null ? photos[lightboxIndex] : null;

  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (lightboxIndex === null) return [];
    const queue: PhotoMeta[] = [];
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const prev = photos[lightboxIndex - offset];
        const next = photos[lightboxIndex + offset];
        if (prev) queue.push(prev);
        if (next) queue.push(next);
    }
    return queue;
  }, [lightboxIndex, photos]);

  if (isLoadingKeys) {
    return (
      <div className="photo-grid-loading">
        <div className="loading-spinner" />
        <p>Loading encryption keys...</p>
      </div>
    );
  }

  return (
    <>
      <div
        ref={parentRef}
        className="photo-grid-container"
        style={{ height: '100%', overflowY: 'auto' }}
        data-testid="shared-mosaic-photo-grid"
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
                           // Find actual photo object
                           const photo = photos.find(p => p.id === mosaicItem.photoId);
                           if (!photo) return null;

                           const tierKey = getTierKey(photo.epochId, accessTier);

                           return (
                               <MosaicTile 
                                   key={photo.id}
                                   item={mosaicItem}
                                   photo={photo}
                                   onClick={() => handlePhotoClick(photo)}
                                   renderThumbnail={({ photo, width, height, onClick }) => (
                                     <div style={{ width, height, overflow: 'hidden' }}>
                                         <SharedPhotoThumbnail
                                            photo={photo}
                                            {...(tierKey ? { tierKey } : {})}
                                            accessTier={accessTier}
                                            {...(onClick ? { onClick } : {})}
                                         />
                                     </div>
                                   )}
                               />
                           );
                        })}
                    </div>
                );
            })}
        </div>
      </div>

       {lightboxIndex !== null && currentPhoto && (
        <SharedPhotoLightbox
          photo={currentPhoto}
          linkId={linkId}
          tierKey={getTierKey(currentPhoto.epochId, accessTier)} // Current photo key
          accessTier={accessTier}
          onClose={() => setLightboxIndex(null)}
          onNext={lightboxIndex < photos.length - 1 ? () => setLightboxIndex(i => i !== null ? i + 1 : null) : undefined}
          onPrevious={lightboxIndex > 0 ? () => setLightboxIndex(i => i !== null ? i - 1 : null) : undefined}
          hasNext={lightboxIndex < photos.length - 1}
          hasPrevious={lightboxIndex > 0}
          preloadQueue={preloadQueue}
          getTierKey={getTierKey}
        />
      )}
    </>
  );
}
