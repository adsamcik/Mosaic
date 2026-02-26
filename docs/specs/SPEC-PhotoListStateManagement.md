# SPEC: Unified Photo List State Management

> **Status:** Design Proposal  
> **Author:** GitHub Copilot  
> **Date:** 2024-12-31  
> **Scope:** `apps/web/src/` photo/album list state management

## 1. Problem Statement

### Current Issues

1. **Scattered Sync Listeners:** Multiple components independently subscribe to `sync-complete`:
   - [Gallery.tsx](../../apps/web/src/components/Gallery/Gallery.tsx#L138-L150)
   - [EnhancedMosaicPhotoGrid.tsx](../../apps/web/src/components/Gallery/EnhancedMosaicPhotoGrid.tsx#L187-L192)
   - [useAlbums.ts](../../apps/web/src/hooks/useAlbums.ts#L441-L453)

2. **Full Array Replacement:** `setPhotos(result)` triggers complete re-renders:
   ```typescript
   // Current: Full replacement on every sync
   const result = await db.getPhotos(albumId, 1000, 0);
   setPhotos(result);  // ← Entire array replaced, all components re-render
   ```

3. **Separate Pending State:** Each grid component duplicates pending photo logic:
   ```typescript
   // Repeated in MosaicPhotoGrid, PhotoGrid, EnhancedMosaicPhotoGrid, SquarePhotoGrid
   const pendingPhotos = activeTasks.filter(...).map(...);
   return [...pendingPhotos, ...photos];
   ```

4. **No Incremental Updates:** Adding/removing photos requires full refetch.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PHOTO STATE MANAGEMENT                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        PhotoStore (Zustand)                          │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────────┐    │    │
│  │  │ photos      │  │ pending     │  │ metadata                  │    │    │
│  │  │ Map<id,     │  │ Map<id,     │  │ { albumId, version,       │    │    │
│  │  │   PhotoMeta>│  │   Pending>  │  │   isLoading, error }      │    │    │
│  │  └─────────────┘  └─────────────┘  └───────────────────────────┘    │    │
│  │                                                                      │    │
│  │  Actions:                                                            │    │
│  │  ├─ addPhotos(photos[])     - Merge without full replace            │    │
│  │  ├─ removePhotos(ids[])     - Delete by ID                          │    │
│  │  ├─ updatePhoto(id, patch)  - Partial update single item            │    │
│  │  ├─ setPending(id, task)    - Add/update pending upload             │    │
│  │  ├─ promotePending(id)      - Transition pending → real photo       │    │
│  │  └─ clearPending(id)        - Remove pending after completion       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    SyncCoordinator (Singleton)                       │    │
│  │  - Single listener for sync-complete events                         │    │
│  │  - Computes delta (added/removed/updated)                           │    │
│  │  - Dispatches incremental actions to PhotoStore                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      Selector Hooks (React)                          │    │
│  │  ┌─────────────────┐  ┌────────────────────┐  ┌─────────────────┐   │    │
│  │  │ usePhotoList    │  │ usePhoto(id)       │  │ usePhotoIds     │   │    │
│  │  │ (albumId)       │  │                    │  │ (albumId)       │   │    │
│  │  │                 │  │ Single photo       │  │                 │   │    │
│  │  │ Returns merged  │  │ subscription       │  │ ID array only   │   │    │
│  │  │ pending + real  │  │ (fine-grained)     │  │ (stable ref)    │   │    │
│  │  └─────────────────┘  └────────────────────┘  └─────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

Data Flow:
┌─────────────┐    sync-complete    ┌───────────────┐    delta    ┌───────────┐
│ SyncEngine  │ ──────────────────► │SyncCoordinator│ ──────────► │PhotoStore │
└─────────────┘                     └───────────────┘             └───────────┘
                                                                        │
┌─────────────┐    setPending       ┌───────────────┐                   │
│UploadQueue  │ ──────────────────► │  PhotoStore   │◄──────────────────┘
└─────────────┘    promotePending   └───────────────┘
                                           │
                                           ▼
                                    ┌─────────────────┐
                                    │  React UI       │
                                    │  (selectors)    │
                                    └─────────────────┘
```

---

## 3. State Shape

### 3.1 Core Types

```typescript
// File: apps/web/src/stores/photo-store.ts

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { PhotoMeta } from '../workers/types';
import type { UploadTask } from '../lib/upload-queue';

/** Pending photo derived from upload task */
export interface PendingPhoto {
  id: string;                    // Same as task.id (assetId)
  task: UploadTask;              // Reference to upload task
  createdAt: string;             // For sorting with real photos
}

/** Album-scoped photo collection state */
export interface AlbumPhotoState {
  /** Map of photo ID → PhotoMeta for O(1) lookup */
  photos: Map<string, PhotoMeta>;
  
  /** Map of pending ID → PendingPhoto for uploads in progress */
  pending: Map<string, PendingPhoto>;
  
  /** Last synced version from server */
  version: number;
  
  /** Loading state */
  isLoading: boolean;
  
  /** Error state */
  error: Error | null;
  
  /** Timestamp of last successful sync */
  lastSyncAt: number | null;
}

/** Root store state */
export interface PhotoStoreState {
  /** Album ID → AlbumPhotoState */
  albums: Map<string, AlbumPhotoState>;
  
  /** Currently active album (for single-album views) */
  activeAlbumId: string | null;
}

/** Store actions */
export interface PhotoStoreActions {
  // Album lifecycle
  initAlbum(albumId: string): void;
  setActiveAlbum(albumId: string | null): void;
  clearAlbum(albumId: string): void;
  
  // Bulk operations (from sync)
  setPhotos(albumId: string, photos: PhotoMeta[], version: number): void;
  addPhotos(albumId: string, photos: PhotoMeta[]): void;
  removePhotos(albumId: string, photoIds: string[]): void;
  
  // Single photo operations
  updatePhoto(albumId: string, photoId: string, patch: Partial<PhotoMeta>): void;
  
  // Pending upload operations
  setPending(albumId: string, task: UploadTask): void;
  updatePending(albumId: string, taskId: string, task: UploadTask): void;
  promotePending(albumId: string, pendingId: string, photo: PhotoMeta): void;
  clearPending(albumId: string, pendingId: string): void;
  
  // Loading/error state
  setLoading(albumId: string, isLoading: boolean): void;
  setError(albumId: string, error: Error | null): void;
}

export type PhotoStore = PhotoStoreState & PhotoStoreActions;
```

### 3.2 Normalized Structure Rationale

Using `Map<string, PhotoMeta>` instead of arrays provides:

| Operation | Array O(n) | Map O(1) |
|-----------|------------|----------|
| Find by ID | `photos.find(p => p.id === id)` | `photos.get(id)` |
| Update by ID | `photos.map(p => ...)` | `photos.set(id, updated)` |
| Remove by ID | `photos.filter(p => p.id !== id)` | `photos.delete(id)` |
| Check existence | `photos.some(p => p.id === id)` | `photos.has(id)` |

---

## 4. Store Implementation

```typescript
// File: apps/web/src/stores/photo-store.ts

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { subscribeWithSelector } from 'zustand/middleware';
import type { PhotoMeta } from '../workers/types';
import type { UploadTask } from '../lib/upload-queue';

function createEmptyAlbumState(): AlbumPhotoState {
  return {
    photos: new Map(),
    pending: new Map(),
    version: 0,
    isLoading: false,
    error: null,
    lastSyncAt: null,
  };
}

export const usePhotoStore = create<PhotoStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      // Initial state
      albums: new Map(),
      activeAlbumId: null,

      // Album lifecycle
      initAlbum: (albumId) =>
        set((state) => {
          if (!state.albums.has(albumId)) {
            state.albums.set(albumId, createEmptyAlbumState());
          }
        }),

      setActiveAlbum: (albumId) =>
        set((state) => {
          state.activeAlbumId = albumId;
        }),

      clearAlbum: (albumId) =>
        set((state) => {
          state.albums.delete(albumId);
        }),

      // Bulk operations
      setPhotos: (albumId, photos, version) =>
        set((state) => {
          const album = state.albums.get(albumId) ?? createEmptyAlbumState();
          album.photos.clear();
          for (const photo of photos) {
            album.photos.set(photo.id, photo);
          }
          album.version = version;
          album.lastSyncAt = Date.now();
          album.isLoading = false;
          state.albums.set(albumId, album);
        }),

      addPhotos: (albumId, photos) =>
        set((state) => {
          const album = state.albums.get(albumId);
          if (album) {
            for (const photo of photos) {
              album.photos.set(photo.id, photo);
            }
          }
        }),

      removePhotos: (albumId, photoIds) =>
        set((state) => {
          const album = state.albums.get(albumId);
          if (album) {
            for (const id of photoIds) {
              album.photos.delete(id);
            }
          }
        }),

      // Single photo operations
      updatePhoto: (albumId, photoId, patch) =>
        set((state) => {
          const album = state.albums.get(albumId);
          const photo = album?.photos.get(photoId);
          if (photo) {
            album!.photos.set(photoId, { ...photo, ...patch });
          }
        }),

      // Pending upload operations
      setPending: (albumId, task) =>
        set((state) => {
          const album = state.albums.get(albumId) ?? createEmptyAlbumState();
          album.pending.set(task.id, {
            id: task.id,
            task,
            createdAt: new Date().toISOString(),
          });
          state.albums.set(albumId, album);
        }),

      updatePending: (albumId, taskId, task) =>
        set((state) => {
          const pending = state.albums.get(albumId)?.pending.get(taskId);
          if (pending) {
            pending.task = task;
          }
        }),

      promotePending: (albumId, pendingId, photo) =>
        set((state) => {
          const album = state.albums.get(albumId);
          if (album) {
            // Remove from pending
            album.pending.delete(pendingId);
            // Add to real photos
            album.photos.set(photo.id, photo);
          }
        }),

      clearPending: (albumId, pendingId) =>
        set((state) => {
          state.albums.get(albumId)?.pending.delete(pendingId);
        }),

      // Loading/error state
      setLoading: (albumId, isLoading) =>
        set((state) => {
          const album = state.albums.get(albumId);
          if (album) {
            album.isLoading = isLoading;
          }
        }),

      setError: (albumId, error) =>
        set((state) => {
          const album = state.albums.get(albumId);
          if (album) {
            album.error = error;
            album.isLoading = false;
          }
        }),
    }))
  )
);
```

---

## 5. Selector Hooks API

### 5.1 Core Selectors

```typescript
// File: apps/web/src/hooks/usePhotoSelectors.ts

import { useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import { usePhotoStore } from '../stores/photo-store';
import type { PhotoMeta } from '../workers/types';

/**
 * Get merged photo list (pending + real) for an album.
 * Sorted by createdAt descending (newest first).
 * 
 * @param albumId - Album to get photos for
 * @returns Merged and sorted photo array
 * 
 * @example
 * ```tsx
 * function Gallery({ albumId }: Props) {
 *   const { photos, isLoading, error } = usePhotoList(albumId);
 *   
 *   if (isLoading) return <Skeleton />;
 *   if (error) return <Error error={error} />;
 *   return <PhotoGrid photos={photos} />;
 * }
 * ```
 */
export function usePhotoList(albumId: string): {
  photos: (PhotoMeta & { isPending?: boolean })[];
  isLoading: boolean;
  error: Error | null;
} {
  // Subscribe to specific album state with shallow comparison
  const albumState = usePhotoStore(
    useShallow((state) => state.albums.get(albumId))
  );

  // Memoize the merged + sorted array
  const photos = useMemo(() => {
    if (!albumState) return [];

    // Convert pending to PhotoMeta-like objects
    const pendingPhotos = Array.from(albumState.pending.values()).map((p) => ({
      id: p.id,
      assetId: p.id,
      albumId: p.task.albumId,
      filename: p.task.file.name,
      mimeType: p.task.file.type,
      width: p.task.originalWidth ?? p.task.thumbWidth ?? 800,
      height: p.task.originalHeight ?? p.task.thumbHeight ?? 600,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
      tags: [],
      shardIds: [],
      epochId: p.task.epochId,
      thumbnail: p.task.thumbnailBase64,
      thumbWidth: p.task.thumbWidth,
      thumbHeight: p.task.thumbHeight,
      isPending: true,
    }));

    // Merge with real photos
    const realPhotos = Array.from(albumState.photos.values()).map((p) => ({
      ...p,
      isPending: false,
    }));

    // Sort by createdAt descending
    return [...pendingPhotos, ...realPhotos].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [albumState]);

  return {
    photos,
    isLoading: albumState?.isLoading ?? true,
    error: albumState?.error ?? null,
  };
}

/**
 * Get a single photo by ID. Only re-renders when this specific photo changes.
 * 
 * @param albumId - Album containing the photo
 * @param photoId - Photo ID to subscribe to
 * @returns Photo or null if not found
 * 
 * @example
 * ```tsx
 * function PhotoThumbnail({ albumId, photoId }: Props) {
 *   const photo = usePhoto(albumId, photoId);
 *   if (!photo) return null;
 *   return <img src={photo.thumbnail} />;
 * }
 * ```
 */
export function usePhoto(
  albumId: string,
  photoId: string
): PhotoMeta | null {
  return usePhotoStore(
    (state) => state.albums.get(albumId)?.photos.get(photoId) ?? null
  );
}

/**
 * Get just the photo IDs for an album. Stable reference unless IDs change.
 * Useful for virtualized lists that only need IDs for item keys.
 * 
 * @param albumId - Album to get photo IDs for
 * @returns Array of photo IDs (sorted by createdAt desc)
 * 
 * @example
 * ```tsx
 * function VirtualList({ albumId }: Props) {
 *   const photoIds = usePhotoIds(albumId);
 *   return (
 *     <VirtualScroller
 *       count={photoIds.length}
 *       renderItem={(index) => (
 *         <PhotoItem key={photoIds[index]} photoId={photoIds[index]} />
 *       )}
 *     />
 *   );
 * }
 * ```
 */
export function usePhotoIds(albumId: string): string[] {
  return usePhotoStore(
    useShallow((state) => {
      const album = state.albums.get(albumId);
      if (!album) return [];

      // Get all IDs (pending + real), sorted by createdAt desc
      const pendingIds = Array.from(album.pending.values())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((p) => p.id);

      const realIds = Array.from(album.photos.values())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((p) => p.id);

      return [...pendingIds, ...realIds];
    })
  );
}

/**
 * Get pending upload for a specific ID.
 * 
 * @param albumId - Album containing the pending upload
 * @param pendingId - Pending upload ID (same as task.id)
 * @returns PendingPhoto or null
 */
export function usePendingUpload(
  albumId: string,
  pendingId: string
): PendingPhoto | null {
  return usePhotoStore(
    (state) => state.albums.get(albumId)?.pending.get(pendingId) ?? null
  );
}

/**
 * Get photo count for an album (pending + real).
 * Useful for album list display without loading full photo data.
 * 
 * @param albumId - Album to count
 * @returns Total photo count
 */
export function usePhotoCount(albumId: string): number {
  return usePhotoStore((state) => {
    const album = state.albums.get(albumId);
    if (!album) return 0;
    return album.photos.size + album.pending.size;
  });
}
```

### 5.2 Action Hooks

```typescript
// File: apps/web/src/hooks/usePhotoActions.ts

import { useCallback } from 'react';
import { usePhotoStore } from '../stores/photo-store';
import type { PhotoMeta } from '../workers/types';
import type { UploadTask } from '../lib/upload-queue';

/**
 * Get photo store actions. Returns stable function references.
 * 
 * @example
 * ```tsx
 * function UploadHandler({ albumId }: Props) {
 *   const { addPending, promotePending } = usePhotoStoreActions();
 *   
 *   const onUploadStart = (task: UploadTask) => {
 *     addPending(albumId, task);
 *   };
 *   
 *   const onUploadComplete = (pendingId: string, photo: PhotoMeta) => {
 *     promotePending(albumId, pendingId, photo);
 *   };
 * }
 * ```
 */
export function usePhotoStoreActions() {
  const store = usePhotoStore();

  return {
    // Already stable from Zustand
    initAlbum: store.initAlbum,
    setActiveAlbum: store.setActiveAlbum,
    clearAlbum: store.clearAlbum,
    setPhotos: store.setPhotos,
    addPhotos: store.addPhotos,
    removePhotos: store.removePhotos,
    updatePhoto: store.updatePhoto,
    setPending: store.setPending,
    updatePending: store.updatePending,
    promotePending: store.promotePending,
    clearPending: store.clearPending,
    setLoading: store.setLoading,
    setError: store.setError,
  };
}
```

---

## 6. Sync Coordinator

Single listener that handles all sync events and dispatches incremental updates:

```typescript
// File: apps/web/src/lib/sync-coordinator.ts

import { syncEngine, type SyncEventDetail } from './sync-engine';
import { getDbClient } from './db-client';
import { usePhotoStore } from '../stores/photo-store';
import { createLogger } from './logger';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('sync-coordinator');

/** Tracks which albums have been initialized */
const initializedAlbums = new Set<string>();

/**
 * Compute delta between old and new photo sets.
 * Returns photos to add, remove, and update.
 */
function computeDelta(
  oldPhotos: Map<string, PhotoMeta>,
  newPhotos: PhotoMeta[]
): {
  added: PhotoMeta[];
  removed: string[];
  updated: PhotoMeta[];
} {
  const newPhotoMap = new Map(newPhotos.map((p) => [p.id, p]));
  
  const added: PhotoMeta[] = [];
  const updated: PhotoMeta[] = [];
  const removed: string[] = [];

  // Find added and updated
  for (const photo of newPhotos) {
    const existing = oldPhotos.get(photo.id);
    if (!existing) {
      added.push(photo);
    } else if (photo.updatedAt !== existing.updatedAt) {
      updated.push(photo);
    }
  }

  // Find removed
  for (const [id] of oldPhotos) {
    if (!newPhotoMap.has(id)) {
      removed.push(id);
    }
  }

  return { added, removed, updated };
}

/**
 * Handle sync-complete event for an album.
 * Fetches updated photos and applies incremental changes.
 */
async function handleSyncComplete(albumId: string): Promise<void> {
  const store = usePhotoStore.getState();
  const albumState = store.albums.get(albumId);

  try {
    const db = await getDbClient();
    const newPhotos = await db.getPhotos(albumId, 1000, 0);
    const currentVersion = await db.getAlbumVersion(albumId);

    if (!albumState || albumState.photos.size === 0) {
      // First load - set all photos
      log.debug(`Initial load for album ${albumId}: ${newPhotos.length} photos`);
      store.setPhotos(albumId, newPhotos, currentVersion);
      return;
    }

    // Compute delta
    const delta = computeDelta(albumState.photos, newPhotos);
    
    log.debug(
      `Sync delta for album ${albumId}: +${delta.added.length} -${delta.removed.length} ~${delta.updated.length}`
    );

    // Apply incremental updates
    if (delta.added.length > 0) {
      store.addPhotos(albumId, delta.added);
    }

    if (delta.removed.length > 0) {
      store.removePhotos(albumId, delta.removed);
    }

    for (const photo of delta.updated) {
      store.updatePhoto(albumId, photo.id, photo);
    }

    // Check for pending photos that should be promoted
    for (const [pendingId, pending] of albumState.pending) {
      const matchingPhoto = newPhotos.find((p) => p.assetId === pendingId);
      if (matchingPhoto) {
        log.debug(`Promoting pending photo ${pendingId} to real photo ${matchingPhoto.id}`);
        store.promotePending(albumId, pendingId, matchingPhoto);
      }
    }
  } catch (err) {
    log.error(`Failed to handle sync-complete for album ${albumId}:`, err);
    store.setError(albumId, err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Initialize the sync coordinator.
 * Should be called once at app startup.
 */
export function initSyncCoordinator(): () => void {
  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<SyncEventDetail>).detail;
    void handleSyncComplete(detail.albumId);
  };

  syncEngine.addEventListener('sync-complete', handleEvent);

  log.info('Sync coordinator initialized');

  // Return cleanup function
  return () => {
    syncEngine.removeEventListener('sync-complete', handleEvent);
    log.info('Sync coordinator disposed');
  };
}
```

---

## 7. Upload Integration

Update UploadContext to dispatch to PhotoStore:

```typescript
// File: apps/web/src/contexts/UploadContext.tsx (modifications)

import { usePhotoStore } from '../stores/photo-store';

// In upload callback, after task is queued:
const store = usePhotoStore.getState();
store.setPending(albumId, task);

// On progress update:
store.updatePending(albumId, task.id, task);

// On upload complete (after manifest created):
// The sync-coordinator will handle promotion when sync-complete fires

// On upload error:
store.clearPending(albumId, task.id);
```

---

## 8. React 19 Optimizations

### 8.1 useTransition for Non-Urgent Updates

```typescript
// File: apps/web/src/components/Gallery/Gallery.tsx

import { useTransition } from 'react';

function Gallery({ albumId }: GalleryProps) {
  const [isPending, startTransition] = useTransition();
  const { photos, isLoading, error } = usePhotoList(albumId);
  const { initAlbum } = usePhotoStoreActions();

  // Initialize album on mount (non-blocking)
  useEffect(() => {
    initAlbum(albumId);
    
    // Trigger initial sync (non-urgent)
    startTransition(() => {
      void syncEngine.sync(albumId);
    });
  }, [albumId, initAlbum]);

  // Show subtle loading indicator for non-urgent updates
  return (
    <div className={isPending ? 'opacity-75' : ''}>
      <PhotoGrid photos={photos} />
    </div>
  );
}
```

### 8.2 useDeferredValue for Expensive Computations

```typescript
// File: apps/web/src/components/Gallery/EnhancedMosaicPhotoGrid.tsx

import { useDeferredValue, useMemo } from 'react';

function EnhancedMosaicPhotoGrid({ albumId }: Props) {
  const { photos } = usePhotoList(albumId);
  
  // Defer layout computation for large photo sets
  const deferredPhotos = useDeferredValue(photos);
  
  // Expensive layout computation uses deferred value
  const virtualRows = useMemo(() => {
    return computeMosaicLayout(deferredPhotos, containerWidth);
  }, [deferredPhotos, containerWidth]);

  // Immediate feedback: show photo count from current value
  const photoCount = photos.length;
  
  return (
    <>
      <div className="photo-count">{photoCount} photos</div>
      <VirtualList rows={virtualRows} />
    </>
  );
}
```

---

## 9. Fine-Grained Subscriptions

### 9.1 Per-Photo Subscription

Each photo component subscribes only to its own data:

```typescript
// File: apps/web/src/components/Gallery/PhotoThumbnail.tsx

interface PhotoThumbnailProps {
  albumId: string;
  photoId: string;
}

export function PhotoThumbnail({ albumId, photoId }: PhotoThumbnailProps) {
  // Only re-renders when THIS photo changes
  const photo = usePhoto(albumId, photoId);
  
  if (!photo) return <Skeleton />;
  
  return (
    <img
      src={photo.thumbnail ? `data:image/jpeg;base64,${photo.thumbnail}` : undefined}
      alt={photo.filename}
      width={photo.thumbWidth}
      height={photo.thumbHeight}
    />
  );
}
```

### 9.2 Virtualized List with ID-Only Subscription

```typescript
// File: apps/web/src/components/Gallery/VirtualPhotoList.tsx

function VirtualPhotoList({ albumId }: Props) {
  // Only re-renders when photo IDs change (add/remove)
  const photoIds = usePhotoIds(albumId);
  const parentRef = useRef<HTMLDivElement>(null);
  
  const virtualizer = useVirtualizer({
    count: photoIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,
  });

  return (
    <div ref={parentRef} className="overflow-auto h-full">
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => (
          <PhotoThumbnail
            key={photoIds[virtual.index]}
            albumId={albumId}
            photoId={photoIds[virtual.index]}
            style={{
              transform: `translateY(${virtual.start}px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
```

---

## 10. Migration Path

### Phase 1: Add Zustand + Immer Dependencies

```bash
cd apps/web
npm install zustand immer
```

### Phase 2: Create Store (Non-Breaking)

1. Create `src/stores/photo-store.ts`
2. Create `src/hooks/usePhotoSelectors.ts`
3. Create `src/lib/sync-coordinator.ts`

### Phase 3: Initialize Coordinator

```typescript
// File: apps/web/src/main.tsx

import { initSyncCoordinator } from './lib/sync-coordinator';

// Initialize sync coordinator before React render
const cleanup = initSyncCoordinator();

// On HMR dispose (development only)
if (import.meta.hot) {
  import.meta.hot.dispose(cleanup);
}
```

### Phase 4: Migrate Components (One at a Time)

| Component | Current | New | Priority |
|-----------|---------|-----|----------|
| Gallery.tsx | `usePhotos` + sync listener | `usePhotoList` | High |
| EnhancedMosaicPhotoGrid.tsx | `activeTasks` merge | `usePhotoList` | High |
| PhotoGrid.tsx | `activeTasks` merge | `usePhotoList` | Medium |
| MosaicPhotoGrid.tsx | `activeTasks` merge | `usePhotoList` | Medium |
| SquarePhotoGrid.tsx | `activeTasks` merge | `usePhotoList` | Low |

### Phase 5: Update UploadContext

1. Remove `activeTasks` state from UploadContext
2. Dispatch to PhotoStore on upload start/progress/complete

### Phase 6: Deprecate Old Hooks

1. Mark `usePhotos` as deprecated
2. Remove per-component sync listeners
3. Remove pending photo merge logic from grid components

---

## 11. Testing Strategy

### Unit Tests

```typescript
// File: apps/web/tests/photo-store.test.ts

describe('PhotoStore', () => {
  beforeEach(() => {
    usePhotoStore.setState({
      albums: new Map(),
      activeAlbumId: null,
    });
  });

  it('should add photos incrementally', () => {
    const { addPhotos, initAlbum } = usePhotoStore.getState();
    
    initAlbum('album-1');
    addPhotos('album-1', [mockPhoto1, mockPhoto2]);
    
    const album = usePhotoStore.getState().albums.get('album-1');
    expect(album?.photos.size).toBe(2);
  });

  it('should promote pending to real photo', () => {
    const { setPending, promotePending, initAlbum } = usePhotoStore.getState();
    
    initAlbum('album-1');
    setPending('album-1', mockTask);
    promotePending('album-1', mockTask.id, mockPhoto);
    
    const album = usePhotoStore.getState().albums.get('album-1');
    expect(album?.pending.size).toBe(0);
    expect(album?.photos.size).toBe(1);
  });
});
```

### Integration Tests

```typescript
// File: apps/web/tests/sync-coordinator.test.ts

describe('SyncCoordinator', () => {
  it('should apply incremental updates on sync-complete', async () => {
    // Setup initial state
    const store = usePhotoStore.getState();
    store.setPhotos('album-1', [mockPhoto1], 1);
    
    // Mock db.getPhotos to return updated data
    vi.mocked(db.getPhotos).mockResolvedValue([mockPhoto1, mockPhoto2]);
    
    // Simulate sync-complete event
    syncEngine.dispatchEvent(new CustomEvent('sync-complete', {
      detail: { albumId: 'album-1' }
    }));
    
    await waitFor(() => {
      const album = usePhotoStore.getState().albums.get('album-1');
      expect(album?.photos.size).toBe(2);
    });
  });
});
```

---

## 12. Performance Comparison

### Before (Current)

| Scenario | Behavior |
|----------|----------|
| 1 photo uploaded | Full `getPhotos()` → `setPhotos()` → All 500 thumbnails re-render |
| Sync complete | 4 components call `refetch()` independently |
| Photo deleted | Full `getPhotos()` → `setPhotos()` → All thumbnails re-render |

### After (Proposed)

| Scenario | Behavior |
|----------|----------|
| 1 photo uploaded | `setPending()` → Single thumbnail renders |
| Sync complete | `SyncCoordinator` computes delta → Only new photos render |
| Photo deleted | `removePhotos([id])` → Only list item unmounts |

---

## 13. Dependencies

### Required New Packages

```json
{
  "dependencies": {
    "zustand": "^5.0.0",
    "immer": "^10.0.0"
  }
}
```

### Why These Choices

| Library | Reason |
|---------|--------|
| **Zustand** | Minimal bundle (1.2kb), React 19 compatible, built-in selectors, no boilerplate |
| **Immer** | Immutable updates with mutable syntax, works perfectly with Zustand middleware |
| **NOT Redux** | Too much boilerplate for this use case |
| **NOT Jotai** | Atomic model less suited for normalized collections |
| **NOT TanStack Query** | Photos come from local SQLite, not HTTP—Query adds unnecessary complexity |

---

## 14. Open Questions

1. **Album-level vs. Global store:** Should we have one store per album (lazy loaded) or one global store with all albums?  
   **Recommendation:** Global store with lazy album initialization—simpler and allows cross-album operations.

2. **History/Undo support:** Should the store support undo for delete operations?  
   **Recommendation:** Not in v1—add later if needed using Zustand temporal middleware.

3. **Persistence:** Should we persist photo state to IndexedDB for offline support?  
   **Recommendation:** No—SQLite is already the source of truth. The store is a cache layer.

---

## 15. Approval Checklist

- [ ] Architecture diagram reviewed
- [ ] State shape approved
- [ ] Hook API signatures approved
- [ ] Migration path approved
- [ ] Dependencies approved (Zustand + Immer)

**Proceed to implementation after approval.**
