# SPEC: Unified Photo List System

> **Status:** Draft  
> **Author:** Copilot  
> **Created:** 2026-01-02  
> **Related Issues:** Upload/refresh blinking, race conditions, missing animations

---

## 1. Problem Statement

The photo gallery currently exhibits a "blinking" issue where the photo list visually disappears and reappears during uploads and syncs. This creates a jarring user experience.

### Root Causes Identified

| # | Category | Issue | Files Involved | Severity |
|---|----------|-------|----------------|----------|
| 1 | **Dual Listeners** | Both `Gallery.tsx` and `EnhancedMosaicPhotoGrid.tsx` listen to `sync-complete` and BOTH call `refetch()`, causing double reload | Gallery.tsx:138-151, EnhancedMosaicPhotoGrid.tsx:186-193 | Critical |
| 2 | **Pending Race** | Upload removes from `activeTasks` BEFORE sync confirms, causing photo to disappear then reappear | UploadContext.tsx:178 | Critical |
| 3 | **Binary Loading** | `isLoading: true` causes full UI replacement with spinner during reloads | usePhotos.ts:23-24 | Critical |
| 4 | **Array Replacement** | `setPhotos(result)` replaces entire photo array, causing full re-render | usePhotos.ts:40 | High |
| 5 | **No Animations** | No Framer Motion or AnimatePresence; only CSS hover effects | All list components | Medium |
| 6 | **Batch Sync Race** | Multiple uploads trigger multiple syncs that skip due to sync lock | UploadContext.tsx | Medium |
| 7 | **Duplicate Handlers** | Both `useUpload` and `UploadContext` set `onComplete` handlers | Multiple | Medium |
| 8 | **No SWR** | Old data immediately replaced instead of shown during refresh | usePhotos.ts | Medium |

---

## 2. Architecture Overview

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER ACTIONS                                     │
│   [Select Files] ──► UploadQueue ──► UploadStoreBridge                  │
│   [Delete Photos] ──► DeleteHandler ─────────────────┐                  │
│   [Refresh] ──► RefreshButton ───────────────────────┤                  │
└──────────────────────────────────────────────────────┼──────────────────┘
                                                       │
                                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         PHOTO STORE (Zustand)                            │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  albums: Map<albumId, AlbumPhotoState>                          │   │
│   │    ├── items: Map<assetId, UnifiedPhotoItem>                    │   │
│   │    ├── sortedIds: string[]                                      │   │
│   │    └── fetchStatus: FetchStatus                                 │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│   Actions:                                                               │
│   ├── addPending(albumId, assetId, file)                                │
│   ├── updateProgress(assetId, progress)                                 │
│   ├── promoteToStable(assetId, serverData)                              │
│   ├── markDeleting(assetIds)                                            │
│   └── completeFetch(albumId, photos)                                    │
└──────────────────────────────────────────────────────┬──────────────────┘
                                                       │
                     ┌─────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     SYNC COORDINATOR (Singleton)                         │
│                                                                          │
│   • ONLY listener for 'sync-complete' events                            │
│   • Debounces rapid events (100ms)                                      │
│   • Fetches fresh data from local DB                                    │
│   • Computes delta (added/removed/updated)                              │
│   • Matches pending items by assetId → promotes to stable               │
│   • Updates PhotoStore with delta                                        │
└──────────────────────────────────────────────────────┬──────────────────┘
                                                       │
                     ┌─────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      REACT COMPONENTS                                    │
│                                                                          │
│   usePhotoList(albumId) ──► selects from PhotoStore                     │
│        │                                                                 │
│        ▼                                                                 │
│   EnhancedMosaicPhotoGrid                                               │
│        │                                                                 │
│        ├── useListAnimation(items) ──► tracks new/existing              │
│        │                                                                 │
│        └── AnimatedTile ──► CSS fade-in/fade-out                        │
│             └── PhotoListItem                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Does NOT Do |
|-----------|----------------|-------------|
| **PhotoStore** | Single source of truth for all photo state | Fetch data, handle events |
| **SyncCoordinator** | Listen to sync-complete, debounce, update store | Render UI, manage uploads |
| **UploadStoreBridge** | Translate upload events → store actions | UI, sync logic |
| **usePhotoList** | Select from store, filter, sort | Fetch, mutate state |
| **useListAnimation** | Track enter/exit animation state | Manage data, fetch |
| **AnimatedTile** | Apply CSS animations based on state | Data logic |

---

## 3. Type Definitions

### Photo Status

```typescript
/**
 * Lifecycle status of a photo in the unified list.
 * 
 * State machine:
 *   pending → uploading → syncing → stable
 *   pending/uploading/syncing → failed (on error)
 *   stable → deleting → (removed)
 */
export type PhotoStatus =
  | 'pending'    // Queued locally, not yet uploading
  | 'uploading'  // Upload in progress (0-100%)
  | 'syncing'    // Uploaded, awaiting server confirmation
  | 'stable'     // Fully synced with server
  | 'deleting'   // Delete in progress (phantom entry for animation)
  | 'failed';    // Operation failed
```

### Fetch Status (Replaces Binary isLoading)

```typescript
/**
 * Discriminated union for fetch status.
 * Enables stale-while-revalidate pattern.
 */
export type FetchStatus =
  | { status: 'idle' }
  | { status: 'loading'; reason: FetchReason }
  | { status: 'refreshing'; reason: FetchReason }  // Has data, fetching more
  | { status: 'error'; error: Error; retryCount: number }
  | { status: 'complete'; fetchedAt: number };

export type FetchReason = 'initial' | 'refresh' | 'sync' | 'search' | 'pagination';
```

### Unified Photo Item

```typescript
/**
 * Single unified type for photos in ANY state.
 * Uses assetId (client-generated) as stable identifier.
 */
export interface UnifiedPhotoItem {
  /** Client-generated UUID, NEVER changes across states */
  readonly assetId: string;
  
  /** Server-assigned ID, null until sync confirms */
  readonly serverId: string | null;
  
  /** Album this photo belongs to */
  readonly albumId: string;
  
  /** Current lifecycle status */
  status: PhotoStatus;
  
  /** Upload progress (0-100), relevant for uploading status */
  progress: number;
  
  /** Error if status === 'failed' */
  error?: Error;
  
  /** Display metadata (available at all states) */
  display: {
    filename: string;
    mimeType: string;
    width: number;
    height: number;
    thumbnailUrl?: string;  // Data URL for pending, server URL for stable
    blurhash?: string;
  };
  
  /** Full server metadata when status === 'stable' */
  serverMeta?: PhotoMeta;
  
  /** Reference to upload task when uploading */
  uploadTask?: UploadTask;
  
  /** Timestamp for sorting (created locally or from server) */
  timestamp: number;
}
```

### Album Photo State

```typescript
export interface AlbumPhotoState {
  /** Normalized photo map: assetId → UnifiedPhotoItem */
  items: Map<string, UnifiedPhotoItem>;
  
  /** Sorted assetId array for rendering */
  sortedIds: string[];
  
  /** Fetch status (replaces binary isLoading) */
  fetchStatus: FetchStatus;
  
  /** Last fetch timestamp for stale-while-revalidate */
  lastFetchAt: number | null;
  
  /** Active fetch ID for deduplication */
  activeFetchId: string | null;
}
```

### Photo Delta (Incremental Updates)

```typescript
/**
 * Represents incremental changes from a sync.
 * Enables efficient partial updates and animation detection.
 */
export interface PhotoDelta {
  albumId: string;
  
  /** New photos from server (trigger enter animation) */
  added: PhotoMeta[];
  
  /** Updated photos (metadata changed) */
  updated: PhotoMeta[];
  
  /** Removed photo assetIds (trigger exit animation) */
  removed: string[];
  
  /** Pending assetIds that were confirmed by server */
  promoted: Array<{ assetId: string; serverData: PhotoMeta }>;
}
```

---

## 4. PhotoStore Implementation

### Store Structure

```typescript
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface PhotoStoreState {
  albums: Map<string, AlbumPhotoState>;
  activeAlbumId: string | null;
}

export interface PhotoStoreActions {
  // Album lifecycle
  initAlbum(albumId: string): void;
  setActiveAlbum(albumId: string | null): void;
  
  // Fetch coordination (prevents duplicates)
  startFetch(albumId: string, fetchId: string): boolean;
  completeFetch(albumId: string, fetchId: string, photos: PhotoMeta[]): void;
  failFetch(albumId: string, fetchId: string, error: Error): void;
  
  // Photo lifecycle
  addPending(albumId: string, assetId: string, file: File, thumbnail: string): void;
  updateProgress(assetId: string, progress: number): void;
  transitionToSyncing(assetId: string): void;
  promoteToStable(assetId: string, serverData: PhotoMeta): void;
  markFailed(assetId: string, error: Error): void;
  
  // Deletion
  markDeleting(albumId: string, assetIds: string[]): void;
  confirmDeleted(albumId: string, assetIds: string[]): void;
  revertDelete(albumId: string, assetIds: string[]): void;
  
  // Delta application
  applyDelta(delta: PhotoDelta): void;
}

export type PhotoStore = PhotoStoreState & PhotoStoreActions;
```

### Key Implementation Details

#### 1. Fetch Deduplication

```typescript
startFetch: (albumId, fetchId) => {
  const album = get().albums.get(albumId);
  
  // Reject if fetch already active
  if (album?.activeFetchId) {
    console.debug(`Fetch already active for ${albumId}, skipping`);
    return false;
  }
  
  set((state) => {
    const a = state.albums.get(albumId)!;
    a.activeFetchId = fetchId;
    a.fetchStatus = { status: 'refreshing', reason: 'sync' };
  });
  
  return true;
}
```

#### 2. Preserve Pending During Fetch

```typescript
completeFetch: (albumId, fetchId, photos) => {
  set((state) => {
    const album = state.albums.get(albumId);
    if (!album || album.activeFetchId !== fetchId) return; // Stale
    
    // Preserve non-stable items
    const preserved = new Map<string, UnifiedPhotoItem>();
    for (const [id, item] of album.items) {
      if (item.status !== 'stable') {
        preserved.set(id, item);
      }
    }
    
    // Add fetched photos
    for (const photo of photos) {
      // Don't overwrite pending items with same assetId
      if (!preserved.has(photo.assetId)) {
        preserved.set(photo.assetId, photoMetaToUnified(photo));
      }
    }
    
    album.items = preserved;
    album.sortedIds = resortIds(preserved);
    album.fetchStatus = { status: 'complete', fetchedAt: Date.now() };
    album.activeFetchId = null;
  });
}
```

#### 3. Stable ID During Promotion

```typescript
promoteToStable: (assetId, serverData) => {
  set((state) => {
    // Find the item (could be in any album)
    for (const album of state.albums.values()) {
      const item = album.items.get(assetId);
      if (item && item.status === 'syncing') {
        // Update in place - DO NOT change the assetId
        item.status = 'stable';
        item.serverId = serverData.id;
        item.serverMeta = serverData;
        item.display.thumbnailUrl = serverData.thumbnailUrl;
        item.progress = 100;
        break;
      }
    }
  });
}
```

---

## 5. SyncCoordinator Implementation

### Singleton Pattern

```typescript
// src/lib/sync-coordinator.ts

class SyncCoordinator {
  private static instance: SyncCoordinator;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 100;
  
  private constructor() {
    // Subscribe to sync-complete events
    window.addEventListener('sync-complete', this.handleSyncComplete);
  }
  
  static getInstance(): SyncCoordinator {
    if (!SyncCoordinator.instance) {
      SyncCoordinator.instance = new SyncCoordinator();
    }
    return SyncCoordinator.instance;
  }
  
  private handleSyncComplete = (event: CustomEvent<{ albumId: string }>) => {
    const { albumId } = event.detail;
    
    // Debounce rapid events
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.processSync(albumId);
    }, this.DEBOUNCE_MS);
  };
  
  private async processSync(albumId: string) {
    const store = usePhotoStore.getState();
    const album = store.albums.get(albumId);
    if (!album) return;
    
    // Fetch fresh data
    const fetchId = `sync-${Date.now()}`;
    if (!store.startFetch(albumId, fetchId)) {
      return; // Another fetch in progress
    }
    
    try {
      const db = await getDbClient();
      const freshPhotos = await db.getPhotos(albumId);
      
      // Compute delta for animations
      const delta = this.computeDelta(album, freshPhotos);
      
      // Apply to store
      store.applyDelta(delta);
      store.completeFetch(albumId, fetchId, freshPhotos);
    } catch (error) {
      store.failFetch(albumId, fetchId, error as Error);
    }
  }
  
  private computeDelta(album: AlbumPhotoState, freshPhotos: PhotoMeta[]): PhotoDelta {
    const existingIds = new Set(
      [...album.items.values()]
        .filter(i => i.status === 'stable')
        .map(i => i.assetId)
    );
    const freshIds = new Set(freshPhotos.map(p => p.assetId));
    
    // Find pending items that now exist on server
    const promoted: PhotoDelta['promoted'] = [];
    for (const [assetId, item] of album.items) {
      if (item.status === 'syncing') {
        const serverData = freshPhotos.find(p => p.assetId === assetId);
        if (serverData) {
          promoted.push({ assetId, serverData });
        }
      }
    }
    
    return {
      albumId: album.albumId,
      added: freshPhotos.filter(p => !existingIds.has(p.assetId)),
      updated: freshPhotos.filter(p => existingIds.has(p.assetId)),
      removed: [...existingIds].filter(id => !freshIds.has(id)),
      promoted,
    };
  }
  
  dispose() {
    window.removeEventListener('sync-complete', this.handleSyncComplete);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}

export const syncCoordinator = SyncCoordinator.getInstance();
```

---

## 6. Upload Integration (UploadStoreBridge)

```typescript
// src/lib/upload-store-bridge.ts

export function initUploadStoreBridge(): () => void {
  const store = usePhotoStore.getState();

  uploadQueue.onTaskQueued = (task: UploadTask) => {
    // Generate assetId client-side (this becomes the stable ID)
    const assetId = task.assetId || crypto.randomUUID();
    store.addPending(task.albumId, assetId, task.file, task.thumbnailBase64);
  };

  uploadQueue.onProgress = (task: UploadTask) => {
    store.updateProgress(task.assetId, task.progress * 100);
  };

  uploadQueue.onComplete = (task: UploadTask) => {
    // Manifest created, now awaiting sync confirmation
    store.transitionToSyncing(task.assetId);
    
    // DO NOT remove from display yet - wait for sync-complete
    // The SyncCoordinator will call promoteToStable when server confirms
  };

  uploadQueue.onError = (task: UploadTask, error: Error) => {
    store.markFailed(task.assetId, error);
  };

  return () => {
    uploadQueue.onTaskQueued = undefined;
    uploadQueue.onProgress = undefined;
    uploadQueue.onComplete = undefined;
    uploadQueue.onError = undefined;
  };
}
```

### Key Design: assetId is Stable

The `assetId` is generated client-side when the upload starts and NEVER changes. This is critical for:

1. **Animation tracking** - useListAnimation sees stable IDs across status changes
2. **No disappear/reappear** - Item stays in list throughout lifecycle
3. **Delta matching** - SyncCoordinator matches by assetId to promote items

---

## 7. Hook API

### usePhotoList (Primary Hook)

```typescript
export function usePhotoList(albumId: string, options?: {
  filter?: (item: UnifiedPhotoItem) => boolean;
  search?: string;
}): {
  photos: UnifiedPhotoItem[];
  isLoading: boolean;        // True only on initial empty load
  isRefreshing: boolean;     // True during background refresh
  error: Error | null;
  refetch: () => void;
} {
  const initAlbum = usePhotoStore(state => state.initAlbum);
  
  useEffect(() => {
    initAlbum(albumId);
    void fetchPhotosForAlbum(albumId);
  }, [albumId, initAlbum]);

  return usePhotoStore(
    useShallow(state => {
      const album = state.albums.get(albumId);
      if (!album) {
        return { photos: [], isLoading: true, isRefreshing: false, error: null, refetch: () => {} };
      }
      
      let photos = album.sortedIds
        .map(id => album.items.get(id)!)
        .filter(Boolean);
      
      // Apply filters
      if (options?.filter) {
        photos = photos.filter(options.filter);
      }
      if (options?.search) {
        const q = options.search.toLowerCase();
        photos = photos.filter(p => p.display.filename.toLowerCase().includes(q));
      }
      
      // Derive loading states
      const fetchStatus = album.fetchStatus;
      const isEmpty = album.items.size === 0;
      const isLoading = fetchStatus.status === 'loading' && isEmpty;
      const isRefreshing = fetchStatus.status === 'refreshing' ||
                          (fetchStatus.status === 'loading' && !isEmpty);
      
      return {
        photos,
        isLoading,
        isRefreshing,
        error: fetchStatus.status === 'error' ? fetchStatus.error : null,
        refetch: () => fetchPhotosForAlbum(albumId, { force: true }),
      };
    })
  );
}
```

### usePhoto (Single Item)

```typescript
export function usePhoto(assetId: string): UnifiedPhotoItem | null {
  return usePhotoStore(state => {
    for (const album of state.albums.values()) {
      const item = album.items.get(assetId);
      if (item) return item;
    }
    return null;
  });
}
```

---

## 8. Animation Integration

### Existing useListAnimation Hook

The codebase already has `useListAnimation` which tracks:
- `seenIds` - Set of IDs seen in previous renders
- `newIds` - Set of IDs that are new this render
- `exitingIds` - Set of IDs that should animate out

### Integration with PhotoStore

```typescript
// In EnhancedMosaicPhotoGrid.tsx

const { photos, isLoading, isRefreshing } = usePhotoList(albumId);

// Prepare items for animation hook
// Include 'deleting' items for exit animation
const itemsForAnimation = useMemo(() => {
  return photos.map(photo => ({
    id: photo.assetId,
    isExiting: photo.status === 'deleting',
  }));
}, [photos]);

const { getAnimationState } = useListAnimation(itemsForAnimation);

// Render
{photos.map(photo => (
  <AnimatedTile
    key={photo.assetId}
    animationState={getAnimationState(photo.assetId)}
  >
    <PhotoListItem photo={photo} />
  </AnimatedTile>
))}
```

### Deleting = Phantom Entry

When a photo is marked as `deleting`:
1. It stays in the `items` Map (phantom entry)
2. `sortedIds` may exclude it OR include it with a visual indicator
3. `useListAnimation` sees `isExiting: true` → applies exit animation
4. After animation completes, `confirmDeleted()` removes from store

---

## 9. Loading State UI

### Derived UI State

```typescript
function deriveUIState(fetchStatus: FetchStatus, hasData: boolean): LoadingUIState {
  switch (fetchStatus.status) {
    case 'loading':
      return hasData ? 'content-refreshing' : 'empty-loading';
    case 'refreshing':
      return 'content-refreshing';
    case 'error':
      return hasData ? 'content-stale' : 'error-empty';
    case 'complete':
    case 'idle':
      return 'content';
  }
}

type LoadingUIState =
  | 'empty-loading'       // Show skeleton
  | 'content'             // Normal render
  | 'content-refreshing'  // Show content + subtle indicator
  | 'content-stale'       // Show content + error badge
  | 'error-empty';        // Show error state
```

### Component Pattern

```tsx
function PhotoGallery({ albumId }: Props) {
  const { photos, isLoading, isRefreshing, error } = usePhotoList(albumId);
  
  // Only show skeleton on initial empty load
  if (isLoading) {
    return <PhotoGridSkeleton />;
  }
  
  // Show error only if we have no data
  if (error && photos.length === 0) {
    return <ErrorState error={error} onRetry={refetch} />;
  }
  
  return (
    <>
      {isRefreshing && <RefreshIndicator />}
      {error && <StaleDataBanner error={error} />}
      <PhotoGrid photos={photos} />
    </>
  );
}
```

---

## 10. Migration Checklist

### Phase 1: Foundation (Day 1)

- [ ] **1.1** Install Zustand: `npm install zustand`
- [ ] **1.2** Create `apps/admin/src/stores/photo-store.types.ts`
- [ ] **1.3** Create `apps/admin/src/stores/photo-store.ts`
- [ ] **1.4** Add unit tests for PhotoStore actions

### Phase 2: Coordination (Day 1-2)

- [ ] **2.1** Create `apps/admin/src/lib/sync-coordinator.ts`
- [ ] **2.2** Create `apps/admin/src/lib/upload-store-bridge.ts`
- [ ] **2.3** Create `apps/admin/src/hooks/usePhotoList.ts`
- [ ] **2.4** Initialize SyncCoordinator in App.tsx

### Phase 3: Component Migration (Day 2)

- [ ] **3.1** Update `EnhancedMosaicPhotoGrid.tsx`:
  - Remove sync-complete listener
  - Replace `usePhotos` with `usePhotoList`
  - Remove `activeTasks` merging logic
- [ ] **3.2** Update `Gallery.tsx`:
  - Remove sync-complete listener
  - Use `usePhotoList` for photos
- [ ] **3.3** Update `UploadContext.tsx`:
  - Remove `activeTasks` state
  - Call `initUploadStoreBridge()` on mount

### Phase 4: Cleanup (Day 2-3)

- [ ] **4.1** Remove sync-complete listener from `useAlbums.ts`
- [ ] **4.2** Update remaining grid components:
  - `MosaicPhotoGrid.tsx`
  - `SquarePhotoGrid.tsx`
  - `PhotoGrid.tsx`
- [ ] **4.3** Deprecate old `usePhotos.ts` (keep as alias for compatibility)
- [ ] **4.4** Run full test suite

### Breaking Changes

| Change | Impact | Mitigation |
|--------|--------|------------|
| `activeTasks` removed from UploadContext | 4 grid components break | Update all 4 together |
| `usePhotos` return type changes | 2 consumers break | Keep old signature, add new fields |
| Sync-complete listeners removed | 4 locations | SyncCoordinator replaces them |

---

## 11. Verification Plan

### Unit Tests

```typescript
describe('PhotoStore', () => {
  it('addPending creates item with pending status', () => {
    store.addPending('album1', 'asset1', file, thumbnail);
    const item = store.albums.get('album1')?.items.get('asset1');
    expect(item?.status).toBe('pending');
    expect(item?.assetId).toBe('asset1');
  });

  it('promoteToStable does NOT change assetId', () => {
    store.addPending('album1', 'asset1', file, thumbnail);
    store.transitionToSyncing('asset1');
    store.promoteToStable('asset1', { id: 'server-123', ...serverData });
    
    const item = store.albums.get('album1')?.items.get('asset1');
    expect(item?.assetId).toBe('asset1');  // NOT 'server-123'
    expect(item?.serverId).toBe('server-123');
    expect(item?.status).toBe('stable');
  });

  it('completeFetch preserves pending items', () => {
    store.addPending('album1', 'pending1', file, thumbnail);
    store.startFetch('album1', 'fetch1');
    store.completeFetch('album1', 'fetch1', [stablePhoto]);
    
    // Both should exist
    expect(store.albums.get('album1')?.items.has('pending1')).toBe(true);
    expect(store.albums.get('album1')?.items.has(stablePhoto.assetId)).toBe(true);
  });

  it('startFetch returns false if fetch already active', () => {
    store.startFetch('album1', 'fetch1');
    const result = store.startFetch('album1', 'fetch2');
    expect(result).toBe(false);
  });
});
```

### Integration Tests

```typescript
describe('Upload Flow Integration', () => {
  it('upload shows in list, stays visible through sync', async () => {
    // Start upload
    await upload(file, albumId);
    
    // Should be visible immediately with pending status
    expect(getVisiblePhotos()).toContainEqual(
      expect.objectContaining({ assetId: expect.any(String), status: 'pending' })
    );
    
    // Wait for upload complete
    await waitFor(() => {
      expect(getVisiblePhotos()).toContainEqual(
        expect.objectContaining({ status: 'syncing' })
      );
    });
    
    // Trigger sync-complete
    dispatchEvent(new CustomEvent('sync-complete', { detail: { albumId } }));
    
    // Should transition to stable without disappearing
    await waitFor(() => {
      expect(getVisiblePhotos()).toContainEqual(
        expect.objectContaining({ status: 'stable' })
      );
    });
    
    // Should never have had 0 photos (the blink)
    expect(minPhotoCount).toBeGreaterThan(0);
  });
});
```

### E2E Tests

```typescript
test('P1-UPLOAD: No blink during batch upload', async ({ page }) => {
  await page.goto('/albums/test-album');
  
  // Record all photo counts during upload
  const counts: number[] = [];
  const observer = setInterval(() => {
    counts.push(page.locator('[data-testid="photo-item"]').count());
  }, 50);
  
  // Upload 5 files
  await page.setInputFiles('[data-testid="file-input"]', files);
  
  // Wait for all to complete
  await expect(page.locator('[data-testid="upload-progress"]')).toHaveCount(0);
  
  clearInterval(observer);
  
  // Verify no count drops (blink = count drops to 0 or previous value)
  const hasNoDrops = counts.every((c, i) => i === 0 || c >= counts[i - 1] - 1);
  expect(hasNoDrops).toBe(true);
});
```

---

## 12. Summary

This SPEC addresses the photo list blinking issue through:

1. **Single source of truth** - Zustand PhotoStore replaces scattered state
2. **Stable IDs** - assetId (client-generated) never changes across lifecycle
3. **Stale-while-revalidate** - Old data shown during refresh, no spinner blink
4. **Single sync listener** - SyncCoordinator eliminates dual listener race
5. **Pending preservation** - Items stay visible from upload start to sync confirm
6. **Animation integration** - Existing useListAnimation works with unified store

Estimated implementation: **2-3 days** with no external blockers identified.
