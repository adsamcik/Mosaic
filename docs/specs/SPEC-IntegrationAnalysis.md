# SPEC: Unified Photo List System Integration Analysis

> **Status:** Analysis Document  
> **Author:** GitHub Copilot (Senior Systems Architect)  
> **Date:** 2026-01-02  
> **Purpose:** Identify conflicts, gaps, and integration points between four related designs

---

## Executive Summary

The four designs (Animation, Loading States, State Management, Sync Coordination) are **fundamentally compatible** but have **critical integration gaps** that must be resolved. The main issues are:

1. **Dual fetch state tracking** - PhotoStore and LoadingState both track fetch status
2. **ID stability during promotion** - Animation system needs stable IDs, but pending→stable changes IDs
3. **Unclear notification pathway** - Animation hook needs to know about item changes, but no clear subscription pattern
4. **Phantom vs Deleting semantics** - Similar concepts with different implementations

---

## 1. Conflicts Found

| Design A | Design B/C/D | Issue | Resolution |
|----------|--------------|-------|------------|
| Animation: `seenKeys` Map for tracking | State: `Map<id, PhotoMeta>` | Two separate Maps tracking overlapping data | Animation should derive from PhotoStore, not maintain separate tracking |
| Animation: `appearedAt` timestamp per item | Loading: `dataUpdatedAt` timestamp | Different granularity (per-item vs per-fetch) | Both needed: `dataUpdatedAt` for staleness, `appearedAt` for animation stagger |
| Animation: "phantom entries" stay in render array | State: `'deleting'` status on item | Same concept, different implementation | **Unify**: Use `status: 'deleting'` as the trigger for phantom behavior |
| Animation: needs stable `itemKey` | Sync: `promotePending()` changes ID from `task.id` to `photo.id` | **BREAKING**: ID change looks like delete+add to animation | **Critical fix needed** - see Section 5 |
| Loading: `FetchStatus` discriminated union | State: `fetchState: { isFetching, lastFetchAt, activeFetchId }` | Redundant fetch tracking | Merge into single `FetchStatus` in PhotoStore |
| Loading: `uiState` derived property | State: `isLoading: boolean` | Loading B's `LoadingUIState` is more expressive | Replace `isLoading` with `FetchStatus` + derived `uiState` |

---

## 2. Gaps Identified

### Gap 1: Animation ↔ PhotoStore Connection

**Problem:** `useAnimatedItems` accepts a `T[]` array and tracks changes via `useMemo`. But PhotoStore uses `Map<string, PhotoMeta>`. There's no clear subscription pathway.

**Current (broken) flow:**
```
PhotoStore (Map) → ??? → useAnimatedItems (array) → AnimatedTile
```

**Questions:**
- Does Animation hook call `usePhotoList()` which converts Map→Array?
- Or does Animation hook subscribe directly to PhotoStore?
- Who computes the `sortedIds` for render order?

**Fix needed:** Define explicit selector that provides:
```typescript
interface PhotoListForAnimation {
  items: UnifiedPhotoItem[];  // Sorted, merged pending+stable
  addedIds: string[];         // IDs added since last render
  removedIds: string[];       // IDs removed (for phantom entries)
}
```

### Gap 2: Pending ID → Stable ID Mapping

**Problem:** Design C states pending items use `task.id` (assetId), but after sync, the stable photo may have a different `photo.id`. Design D's `promoteToStable()` needs to map these.

**Missing specification:**
- What is the stable ID? Is it `assetId` (client-generated) or `photo.id` (server-assigned)?
- If both exist, how does `useAnimatedItems` track the "same" photo across the transition?

**Fix needed:** The answer is in Design D's "Match by assetId" - both pending and stable items should use `assetId` as the stable key, NOT the server's `id`.

### Gap 3: Who Initiates Fetch After Sync?

**Problem:** Design D's SyncCoordinator is the single `sync-complete` listener. But:
- Does it call `db.getPhotos()` to fetch updated data?
- Or does it compute delta from the sync event itself?
- Design B's `usePhotos` also has a `refetch()` function. Who calls it?

**Current ambiguity:**
```
sync-complete event 
   → SyncCoordinator (updates PhotoStore directly? or triggers refetch?)
   → PhotoStore (has setPhotos, but who calls it?)
   → usePhotos (has refetch, is this redundant?)
```

**Fix needed:** Clear ownership:
1. `SyncCoordinator` calls `db.getPhotos()` on `sync-complete`
2. `SyncCoordinator` calls `PhotoStore.setPhotos()` with delta
3. `usePhotos.refetch()` is only for manual refresh (pull-to-refresh)

### Gap 4: Loading State Location

**Problem:** Design B defines `FetchStatus` as React hook state. Design C defines `AlbumPhotoState.isLoading` in Zustand store. Which is source of truth?

**Options:**
- **Option A:** FetchStatus in Zustand (PhotoStore owns all state)
- **Option B:** FetchStatus in React hooks (PhotoStore is just cache)

**Recommendation:** Option A - PhotoStore owns `FetchStatus` so SyncCoordinator can update it:
```typescript
interface AlbumPhotoState {
  photos: Map<string, PhotoMeta>;
  pending: Map<string, PendingPhoto>;
  fetchStatus: FetchStatus;  // ← Move from hook to store
  version: number;
}
```

### Gap 5: Exit Animation Trigger

**Problem:** Design A's `AnimatedTile` receives `isExiting: boolean` prop. But who sets this?

**Missing flow:**
```
User clicks delete → ??? → isExiting=true → AnimatedTile animates → onExitComplete → ???
```

**Fix needed:** Define the delete flow:
1. `deletePhoto()` action sets item `status: 'deleting'`
2. `useAnimatedItems` sees status change, marks as `isExiting`
3. After animation, `onExitComplete` calls `removePhoto()` to actually delete

---

## 3. Integration Proposal

### 3.1 Unified Type Hierarchy

```typescript
// ============ CORE TYPES (from Design C, enhanced) ============

/** Photo lifecycle status - SINGLE source of truth */
export type PhotoStatus = 
  | 'pending'      // Upload queued, not started
  | 'uploading'    // Chunks being uploaded
  | 'processing'   // Manifest being created
  | 'syncing'      // Waiting for server confirmation
  | 'stable'       // Confirmed on server
  | 'deleting'     // Marked for deletion, animating out
  | 'failed';      // Upload/sync failed

/** Unified photo item - pending and stable are same shape */
export interface UnifiedPhotoItem {
  /** Stable identifier: assetId for pending, assetId for stable */
  id: string;
  
  /** Photo status in lifecycle */
  status: PhotoStatus;
  
  /** Album membership */
  albumId: string;
  
  /** Display metadata (always available) */
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  thumbnail: string;
  
  /** Timestamps for sorting and staleness */
  createdAt: string;
  updatedAt: string;
  
  /** Upload-specific (undefined for stable items) */
  uploadProgress?: number;
  uploadError?: string;
  
  /** When this item first appeared (for animation stagger) */
  appearedAt: number;
}

// ============ FETCH STATUS (from Design B) ============

export type FetchReason = 
  | 'initial'
  | 'refresh'
  | 'search'
  | 'dependency-change'
  | 'sync-complete'   // ← Added: sync triggered refresh
  | 'retry';

export type FetchStatus =
  | { status: 'idle' }
  | { status: 'loading'; reason: FetchReason }
  | { status: 'success'; timestamp: number }
  | { status: 'error'; error: Error; retryCount: number };

// ============ ALBUM STATE (from Design C, with FetchStatus) ============

export interface AlbumPhotoState {
  /** All photos by stable ID (assetId) */
  photos: Map<string, UnifiedPhotoItem>;
  
  /** Current fetch status (replaces isLoading) */
  fetchStatus: FetchStatus;
  
  /** Server sync version */
  version: number;
  
  /** Last successful fetch timestamp (for staleness) */
  lastFetchAt: number | null;
}
```

### 3.2 Component Responsibility Matrix

| Component | Owns | Reads | Writes |
|-----------|------|-------|--------|
| **PhotoStore** (Zustand) | `AlbumPhotoState` | - | All photo mutations |
| **SyncCoordinator** | sync-complete listener | syncEngine events | PhotoStore.completeFetch(), PhotoStore.promoteToStable() |
| **SyncRequestQueue** | debounce logic | - | syncEngine.sync() |
| **UploadLifecycleManager** | upload state machine | UploadQueue events | PhotoStore.addPending(), PhotoStore.updateStatus() |
| **usePhotoList** (hook) | - | PhotoStore.photos | - |
| **useAnimatedItems** (hook) | seen items tracking | usePhotoList output | Animation state |
| **AnimatedTile** | animation phase | isExiting prop | onExitComplete callback |

### 3.3 State Derivation Chain

```
PhotoStore.photos (Map<id, UnifiedPhotoItem>)
    │
    ├── usePhotoList(albumId)
    │       → Converts Map to sorted array
    │       → Returns { items, fetchStatus, uiState }
    │
    ├── useAnimatedItems(items)
    │       → Tracks enter/exit state
    │       → Adds phantom entries for exiting items
    │       → Returns { animatedItems, getStaggerDelay }
    │
    └── AnimatedTile
            → Applies CSS animations based on phase
```

---

## 4. Unified Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           UNIFIED PHOTO LIST DATA FLOW                               │
└─────────────────────────────────────────────────────────────────────────────────────┘

                              USER ACTIONS
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
         ▼                         ▼                         ▼
   ┌───────────┐            ┌───────────┐            ┌───────────┐
   │  UPLOAD   │            │  DELETE   │            │  REFRESH  │
   │  FILES    │            │  PHOTO    │            │  BUTTON   │
   └─────┬─────┘            └─────┬─────┘            └─────┬─────┘
         │                         │                         │
         ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│UploadLifecycle  │       │  PhotoStore     │       │  usePhotos      │
│   Manager       │       │ .updateStatus() │       │  .refetch()     │
│                 │       │ status='deleting│       │  reason='refresh│
│ status='pending'│       └────────┬────────┘       └────────┬────────┘
│ status='upload' │                │                         │
│ status='syncing'│                ▼                         │
└────────┬────────┘       ┌─────────────────┐                │
         │                │ useAnimatedItems │                │
         │                │ sees status      │                │
         │                │ marks isExiting  │                │
         │                └────────┬────────┘                │
         │                         │                         │
         │                         ▼                         │
         │                ┌─────────────────┐                │
         │                │  AnimatedTile   │                │
         │                │  exit animation │                │
         │                │  (300ms)        │                │
         │                └────────┬────────┘                │
         │                         │                         │
         │                         ▼                         │
         │                ┌─────────────────┐                │
         │                │ onExitComplete  │                │
         │                │ PhotoStore      │                │
         │                │ .removePhoto()  │                │
         │                └─────────────────┘                │
         │                                                   │
         ▼                                                   │
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              SYNC REQUEST QUEUE                                      │
│  ┌────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Debounce 100ms │ Coalesce by albumId │ Batch window 200ms                     │ │
│  └────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┬────────────────────────────────────┘
                                                 │
                                                 ▼
                                    ┌───────────────────────┐
                                    │    syncEngine.sync()  │
                                    │    (single call per   │
                                    │     batch window)     │
                                    └───────────┬───────────┘
                                                │
                                                ▼
                                    ┌───────────────────────┐
                                    │   sync-complete       │
                                    │   event dispatched    │
                                    └───────────┬───────────┘
                                                │
                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              SYNC COORDINATOR (SINGLETON)                            │
│  ┌────────────────────────────────────────────────────────────────────────────────┐ │
│  │ 1. PhotoStore.setFetchStatus('loading', 'sync-complete')                       │ │
│  │ 2. const newPhotos = await db.getPhotos(albumId)                               │ │
│  │ 3. delta = computeDelta(store.photos, newPhotos)                               │ │
│  │ 4. PhotoStore.completeFetch(albumId, delta)                                    │ │
│  │    - For each added: addPhoto() with status='stable'                           │ │
│  │    - For each matched pending: promoteToStable() (status='stable')             │ │
│  │    - For each removed: (server-side delete, rare case)                         │ │
│  │ 5. PhotoStore.setFetchStatus('success')                                        │ │
│  └────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┬────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                   PHOTO STORE (Zustand)                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐│
│  │ albums: Map<albumId, {                                                          ││
│  │   photos: Map<assetId, UnifiedPhotoItem>,                                       ││
│  │   fetchStatus: FetchStatus,                                                     ││
│  │   version: number                                                               ││
│  │ }>                                                                              ││
│  └─────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────┬────────────────────────────────────┘
                                                 │
                                                 │ Zustand subscription
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                   usePhotoList(albumId)                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐│
│  │ Input:  PhotoStore.albums.get(albumId)                                          ││
│  │ Output: {                                                                       ││
│  │   items: UnifiedPhotoItem[] (sorted by createdAt DESC),                         ││
│  │   fetchStatus: FetchStatus,                                                     ││
│  │   uiState: LoadingUIState (derived)                                             ││
│  │ }                                                                               ││
│  └─────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────┬────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            useAnimatedItems(items, getKey)                           │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐│
│  │ Tracks:                                                                         ││
│  │   - seenKeys: Map<id, timestamp> (when items first appeared)                    ││
│  │   - exitingKeys: Set<id> (items animating out)                                  ││
│  │                                                                                 ││
│  │ Logic:                                                                          ││
│  │   - New items (not in seenKeys) → appearedAt = now, entering animation          ││
│  │   - Items with status='deleting' → add to exitingKeys                           ││
│  │   - Exiting items kept as "phantom entries" in output                           ││
│  │                                                                                 ││
│  │ Output: {                                                                       ││
│  │   animatedItems: AnimatedItem<UnifiedPhotoItem>[],                              ││
│  │   getStaggerDelay: (id) => number,                                              ││
│  │   handleExitComplete: (id) => void                                              ││
│  │ }                                                                               ││
│  └─────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────┬────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                 RENDER LAYER                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐│
│  │ {uiState === 'empty-loading' && <PhotoGridSkeleton />}                          ││
│  │ {uiState === 'content-refreshing' && <RefreshIndicator />}                      ││
│  │ {uiState === 'error-empty' && <ErrorState onRetry={retry} />}                   ││
│  │                                                                                 ││
│  │ <VirtualizedGrid>                                                               ││
│  │   {animatedItems.map(({ item, isExiting, key }) => (                            ││
│  │     <AnimatedTile                                                               ││
│  │       key={key}                                                                 ││
│  │       itemKey={key}                                                             ││
│  │       isExiting={isExiting}                                                     ││
│  │       staggerDelay={getStaggerDelay(key)}                                       ││
│  │       onExitComplete={() => handleExitComplete(key)}                            ││
│  │     >                                                                           ││
│  │       <PhotoTile photo={item} />                                                ││
│  │     </AnimatedTile>                                                             ││
│  │   ))}                                                                           ││
│  │ </VirtualizedGrid>                                                              ││
│  └─────────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Recommendations

### 5.1 Design A (Animation System) Changes

| Current | Change To | Reason |
|---------|-----------|--------|
| `useAnimatedItems` maintains its own `seenKeys` | Keep, but derive `isExiting` from `item.status === 'deleting'` | Cleaner integration with PhotoStore |
| Phantom entries created by hook | Phantom entries are items with `status: 'deleting'` already in the array | Single source of truth |
| `appearedAt` passed as prop | Store `appearedAt` in `UnifiedPhotoItem` | Consistent tracking across renders |
| No awareness of upload status | Check `item.status` for special rendering (progress bar, error state) | Upload-aware animations |

**New signature for `useAnimatedItems`:**
```typescript
function useAnimatedItems(
  items: UnifiedPhotoItem[],
  options: {
    getKey: (item: UnifiedPhotoItem) => string;
    onRemoveComplete?: (key: string) => void;
  }
): {
  animatedItems: Array<{
    item: UnifiedPhotoItem;
    key: string;
    phase: 'entering' | 'entered' | 'exiting';
    staggerDelay: number;
  }>;
  handleExitComplete: (key: string) => void;
}
```

### 5.2 Design B (Loading States) Changes

| Current | Change To | Reason |
|---------|-----------|--------|
| `FetchStatus` in React hook state | `FetchStatus` in PhotoStore | SyncCoordinator needs to update it |
| `useFetchState` primitive hook | `useAlbumFetchStatus(albumId)` selector | Reads from store |
| `usePhotos` manages fetch lifecycle | `SyncCoordinator` + `PhotoStore` manage fetch | Single responsibility |
| `refetch()` does database query | `refetch()` calls `SyncRequestQueue.requestSync()` | Unified sync path |

**New approach:**
```typescript
// PhotoStore action
setFetchStatus(albumId: string, status: FetchStatus): void;

// Selector hook
function useFetchStatus(albumId: string): {
  fetchStatus: FetchStatus;
  uiState: LoadingUIState;
  refetch: (reason?: FetchReason) => void;
}
```

### 5.3 Design C (State Management) Changes

| Current | Change To | Reason |
|---------|-----------|--------|
| `photos: Map` + `pending: Map` | Single `photos: Map<string, UnifiedPhotoItem>` | Unified type |
| `isLoading: boolean` | `fetchStatus: FetchStatus` | Richer state machine |
| Separate `PendingPhoto` type | `UnifiedPhotoItem` with `status: 'pending'\|'uploading'` | Consistent rendering |
| `promotePending(pendingId, photo)` | `promoteToStable(assetId)` (status change only) | ID stays the same! |

**Critical fix for ID stability:**
```typescript
// OLD: IDs change during promotion (breaks animation)
promotePending: (albumId, pendingId, photo) => {
  album.pending.delete(pendingId);      // Remove old ID
  album.photos.set(photo.id, photo);    // Add new ID ← BREAKS ANIMATION
}

// NEW: Same ID, status change only
promoteToStable: (albumId, assetId) => {
  const item = album.photos.get(assetId);
  if (item) {
    item.status = 'stable';             // Same ID, status update
  }
}
```

### 5.4 Design D (Sync Coordination) Changes

| Current | Change To | Reason |
|---------|-----------|--------|
| `UploadLifecycleManager` separate from store | `UploadLifecycleManager` writes to PhotoStore | Single state location |
| Upload states in separate tracking | Upload states via `PhotoStore.updateStatus()` | Unified |
| `promoteToStable()` in SyncCoordinator | Call `PhotoStore.promoteToStable(assetId)` | Centralized |
| 'confirmed' state in upload lifecycle | `status: 'stable'` in UnifiedPhotoItem | Same concept |

**Simplified SyncCoordinator.onSyncComplete:**
```typescript
async handleSyncComplete(event: SyncEventDetail) {
  const { albumId } = event;
  
  // 1. Start loading state
  photoStore.setFetchStatus(albumId, { status: 'loading', reason: 'sync-complete' });
  
  // 2. Fetch latest from DB
  const db = await getDbClient();
  const newPhotos = await db.getPhotos(albumId);
  
  // 3. Get current photos for delta
  const current = photoStore.getState().albums.get(albumId)?.photos ?? new Map();
  
  // 4. Compute delta
  const newAssetIds = new Set(newPhotos.map(p => p.assetId));
  
  // 5. Apply updates
  for (const photo of newPhotos) {
    const existing = current.get(photo.assetId);
    if (existing && existing.status !== 'stable') {
      // Pending upload now confirmed → promote
      photoStore.promoteToStable(albumId, photo.assetId);
    } else if (!existing) {
      // New photo (added by another client?)
      photoStore.addPhoto(albumId, {
        ...photo,
        status: 'stable',
        appearedAt: Date.now(),
      });
    }
  }
  
  // 6. Complete fetch
  photoStore.setFetchStatus(albumId, { status: 'success', timestamp: Date.now() });
}
```

---

## 6. Integration Checklist

Before implementation, verify these integration points:

- [ ] **ID Consistency:** `assetId` is the stable key everywhere (pending, stable, animation)
- [ ] **Single Fetch Status:** `FetchStatus` lives in PhotoStore, not React state
- [ ] **Single Sync Listener:** Only `SyncCoordinator` listens to `sync-complete`
- [ ] **Delete Flow:** User action → `status: 'deleting'` → animation → `removePhoto()`
- [ ] **Promotion Flow:** `promoteToStable()` only changes status, not ID
- [ ] **Animation Trigger:** `useAnimatedItems` reads `status` to determine `isExiting`
- [ ] **Loading UI:** Components use `uiState` derived from `FetchStatus`
- [ ] **Stale-While-Revalidate:** `sync-complete` doesn't clear existing data

---

## 7. Answers to Original Questions

### Q1: Animation + State: How does `useListAnimation` get notified when items are added/deleted?

**Answer:** Via Zustand subscription chain:
1. `SyncCoordinator` or `UploadLifecycleManager` updates `PhotoStore`
2. `usePhotoList(albumId)` selector receives new `photos` Map
3. `useAnimatedItems(items)` receives the converted array
4. Hook compares with previous via `useMemo` dependencies
5. Detects added/removed items by key comparison

No direct subscription—just React's normal re-render flow through selectors.

### Q2: Loading + State: PhotoStore has `fetchState.isFetching`. Design B has `FetchStatus`. Are these redundant?

**Answer:** **Yes, they're redundant.** Unify by:
- Remove `isLoading: boolean` from Design C
- Add `fetchStatus: FetchStatus` to `AlbumPhotoState` (from Design B)
- `SyncCoordinator` calls `PhotoStore.setFetchStatus()` during operations
- Components use `useFetchStatus(albumId)` selector

### Q3: Animation + Sync: When `promoteToStable()` changes a pending item's ID, does animation system see this as delete+add?

**Answer:** **With current design, YES—it breaks animation.**

**Fix:** Use `assetId` as the stable key for BOTH pending and stable items. The `promoteToStable(assetId)` action should ONLY update the `status` field from `'syncing'` to `'stable'`, NOT change the map key.

```typescript
// WRONG (current)
album.pending.delete(pendingId);     // key="abc-123"
album.photos.set(photo.id, photo);   // key="server-456" ← DIFFERENT!

// CORRECT (fixed)
album.photos.set(assetId, {
  ...existingItem,
  status: 'stable',
  // Keep same assetId as key
});
```

### Q4: Phantom entries + Deleting status: Are these the same concept?

**Answer:** **Same concept, different implementations.**

- Design A: "Phantom entries" = items kept in render array during exit animation
- Design C: `status: 'deleting'` = item marked for removal

**Unify:** Items with `status: 'deleting'` ARE the phantom entries. The animation hook should:
1. See `status: 'deleting'` → mark as `isExiting: true`
2. Keep item in render output (as "phantom")
3. After animation completes → call `PhotoStore.removePhoto()`

### Q5: Who owns what state? Any state duplicated?

**Answer:** Yes, several duplications exist:

| State | Design A | Design B | Design C | Design D | **Unified Owner** |
|-------|----------|----------|----------|----------|-------------------|
| Photo list | — | `data` in hook | `photos` Map | — | **PhotoStore** |
| Loading state | — | `FetchStatus` in hook | `isLoading` | — | **PhotoStore.fetchStatus** |
| Pending uploads | — | — | `pending` Map | `TrackedUpload` | **PhotoStore** (unified with photos) |
| Item first seen | `seenKeys` Map | — | — | — | **Animation hook** (correct) |
| Exiting items | `exitingKeys` Set | — | `status: 'deleting'` | — | **PhotoStore.status** |

**After unification:**
- **PhotoStore** owns: photos (including pending), fetchStatus, version
- **UploadLifecycleManager** owns: upload queue, progress callbacks
- **SyncCoordinator** owns: sync-complete handling, delta computation
- **Animation hook** owns: seenKeys (for stagger), animation phase

---

## 8. Implementation Priority

1. **🔴 Critical:** Unify photo ID to always use `assetId` (blocks animation)
2. **🔴 Critical:** Move `FetchStatus` to PhotoStore (blocks loading states)
3. **🟡 High:** Merge pending/stable into single Map with status field
4. **🟡 High:** Update `useAnimatedItems` to read `status: 'deleting'`
5. **🟢 Medium:** Implement `SyncCoordinator.handleSyncComplete` with delta logic
6. **🟢 Medium:** Add `LoadingUIState` derivation to selectors
7. **🔵 Low:** Remove redundant isLoading boolean from components
