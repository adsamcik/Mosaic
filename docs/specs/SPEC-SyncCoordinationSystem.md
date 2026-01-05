# SPEC: Sync Coordination System

> **Status:** Design Proposal  
> **Author:** GitHub Copilot  
> **Date:** 2026-01-02  
> **Scope:** `apps/admin/src/` sync coordination, upload lifecycle, refetch deduplication

## 1. Problem Statement

### Current Race Conditions

The Mosaic photo gallery has four critical race conditions in its sync/upload flow:

#### Race 1: Dual Sync Listeners (Duplicate Refetch)

**Location:** [Gallery.tsx#L138-150](../../apps/admin/src/components/Gallery/Gallery.tsx#L138-L150) and [EnhancedMosaicPhotoGrid.tsx#L218-223](../../apps/admin/src/components/Gallery/EnhancedMosaicPhotoGrid.tsx#L218-L223)

Both components independently listen to `sync-complete` events and call `refetch()`:

```typescript
// Gallery.tsx:138-150
useEffect(() => {
  const handleSyncComplete = (event: Event) => {
    const detail = (event as CustomEvent<SyncEventDetail>).detail;
    if (detail.albumId === albumId) {
      reloadPhotos(); // ← First refetch
    }
  };
  syncEngine.addEventListener('sync-complete', handleSyncComplete);
  return () => syncEngine.removeEventListener('sync-complete', handleSyncComplete);
}, [albumId, reloadPhotos]);

// EnhancedMosaicPhotoGrid.tsx:218-223
useEffect(() => {
  const handleSyncComplete = (event: Event) => {
    const detail = (event as CustomEvent<SyncEventDetail>).detail;
    if (detail.albumId === albumId) refetch(); // ← DUPLICATE refetch!
  };
  syncEngine.addEventListener('sync-complete', handleSyncComplete);
  return () => syncEngine.removeEventListener('sync-complete', handleSyncComplete);
}, [albumId, refetch]);
```

**Impact:** Every sync triggers two database queries and two re-renders.

---

#### Race 2: Batch Upload Sync Collision

**Location:** [UploadContext.tsx#L176-192](../../apps/admin/src/contexts/UploadContext.tsx#L176-L192)

When uploading multiple files, each `onComplete` triggers `syncEngine.sync()`:

```typescript
uploadQueue.onComplete = async (task, shardIds) => {
  await createManifestForUpload(task, shardIds, epochKey);
  await syncEngine.sync(task.albumId, epochKey.epochSeed); // ← Triggers sync
};
```

The sync engine has a lock:

```typescript
// sync-engine.ts:73-76
async sync(albumId: string, readKey?: Uint8Array): Promise<void> {
  if (this.syncing) {
    log.warn('Sync already in progress');
    return; // ← Subsequent syncs SKIPPED!
  }
```

**Impact:** In a 10-file batch upload, only 1-2 syncs complete; other photos don't appear until next manual sync.

---

#### Race 3: Premature Pending Removal

**Location:** [UploadContext.tsx#L177](../../apps/admin/src/contexts/UploadContext.tsx#L177)

Pending upload is removed BEFORE sync completes:

```typescript
uploadQueue.onComplete = async (task, shardIds) => {
  setActiveTasks((prev) => prev.filter((t) => t.id !== task.id)); // ← Removed immediately!
  
  await createManifestForUpload(task, shardIds, epochKey);
  await syncEngine.sync(task.albumId, epochKey.epochSeed); // ← Sync happens AFTER
};
```

**Impact:** Photo disappears from UI, then reappears 500ms-2s later after sync completes.

---

#### Race 4: Competing onComplete Handlers

**Location:** [useUpload.ts#L137](../../apps/admin/src/hooks/useUpload.ts#L137) and [UploadContext.tsx#L176](../../apps/admin/src/contexts/UploadContext.tsx#L176)

Both modules set `uploadQueue.onComplete`, but only the last assignment wins:

```typescript
// useUpload.ts:137
uploadQueue.onComplete = async (task, shardIds) => { ... };

// UploadContext.tsx:176 (overwrites the above)
uploadQueue.onComplete = async (task, shardIds) => { ... };
```

**Impact:** Depending on initialization order, either the hook's or context's completion logic runs, but not both.

---

## 2. Current Event Flow (Broken)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CURRENT FLOW (RACE CONDITIONS)                       │
└─────────────────────────────────────────────────────────────────────────────┘

                                   Batch Upload (3 files)
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            │                             │                             │
            ▼                             ▼                             ▼
      File 1 complete             File 2 complete              File 3 complete
            │                             │                             │
            ▼                             ▼                             ▼
   ┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
   │ onComplete #1    │          │ onComplete #2    │         │ onComplete #3    │
   │ - Remove pending │←─RACE 3──│ - Remove pending │         │ - Remove pending │
   │ - Create manifest│          │ - Create manifest│         │ - Create manifest│
   │ - Trigger sync   │          │ - Trigger sync   │         │ - Trigger sync   │
   └────────┬─────────┘          └────────┬─────────┘         └────────┬─────────┘
            │                             │                             │
            ▼                             ▼                             ▼
   ┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
   │ syncEngine.sync()│          │ syncEngine.sync()│         │ syncEngine.sync()│
   │ (Acquires lock)  │          │ (LOCK HELD-SKIP!)│←RACE 2──│ (LOCK HELD-SKIP!)│
   └────────┬─────────┘          └──────────────────┘         └──────────────────┘
            │
            ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                     dispatch 'sync-complete' event                        │
   └──────────────────────────────────────────────────────────────────────────┘
            │
            ├───────────────────────────────┐
            ▼                               ▼
   ┌──────────────────┐            ┌──────────────────────────┐
   │ Gallery.tsx      │            │ EnhancedMosaicPhotoGrid  │
   │ handleSyncComplete│           │ handleSyncComplete       │
   │ → reloadPhotos() │←──RACE 1──→│ → refetch()              │
   │ (DB Query #1)    │            │ (DUPLICATE DB Query #2!) │
   └──────────────────┘            └──────────────────────────┘
```

---

## 3. Proposed Architecture

### 3.1 High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      NEW ARCHITECTURE: SYNC COORDINATOR                      │
└─────────────────────────────────────────────────────────────────────────────┘

                              Upload Events
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UploadLifecycleManager                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ State Machine per Upload:                                            │    │
│  │   pending → uploading → manifest-creating → syncing → confirmed     │    │
│  │      │          │              │               │            │        │    │
│  │      ▼          ▼              ▼               ▼            ▼        │    │
│  │   [visible] [visible]     [visible]       [visible]   [promoted]    │    │
│  │   pending   pending       pending         pending     to real       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ SyncRequestQueue (Debounced):                                        │    │
│  │   - Coalesces rapid sync requests                                    │    │
│  │   - Waits for pending manifests to complete                          │    │
│  │   - Single sync after all batch uploads finish                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SyncCoordinator                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Single Listener for sync-complete:                                   │    │
│  │   - Registers ONCE at app startup                                    │    │
│  │   - Routes events to appropriate handlers                            │    │
│  │   - Promotes pending → confirmed when server confirms                │    │
│  │   - Emits normalized 'photos-changed' event for UI                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PhotoStore                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────┐     │
│  │ photos:      │   │ pending:     │   │ metadata:                    │     │
│  │ Map<id,Photo>│   │ Map<id,      │   │ { albumId, version,          │     │
│  │              │   │   Pending>   │   │   lastSyncAt }               │     │
│  └──────────────┘   └──────────────┘   └──────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           React Components                                   │
│                    (Subscribe via selectors only)                            │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │ NO direct sync-complete listeners!                                  │     │
│  │ Only subscribe to PhotoStore via usePhotoList() hook               │     │
│  └────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 Detailed Event Flow (Fixed)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        NEW FLOW (NO RACE CONDITIONS)                         │
└─────────────────────────────────────────────────────────────────────────────┘

                                   Batch Upload (3 files)
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            │                             │                             │
            ▼                             ▼                             ▼
      File 1 complete             File 2 complete              File 3 complete
            │                             │                             │
            ▼                             ▼                             ▼
   ┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
   │ setState:        │          │ setState:        │         │ setState:        │
   │ 'manifest-       │          │ 'manifest-       │         │ 'manifest-       │
   │  creating'       │          │  creating'       │         │  creating'       │
   │ (Still visible!) │          │ (Still visible!) │         │ (Still visible!) │
   └────────┬─────────┘          └────────┬─────────┘         └────────┬─────────┘
            │                             │                             │
            ▼                             ▼                             ▼
   ┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
   │ Create manifest  │          │ Create manifest  │         │ Create manifest  │
   │ setState:        │          │ setState:        │         │ setState:        │
   │ 'awaiting-sync'  │          │ 'awaiting-sync'  │         │ 'awaiting-sync'  │
   └────────┬─────────┘          └────────┬─────────┘         └────────┬─────────┘
            │                             │                             │
            └─────────────────────────────┼─────────────────────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │    SyncRequestQueue          │
                           │    - Debounce: 100ms         │
                           │    - Coalesce by albumId     │
                           │    - Wait for all pending    │
                           │      manifests (batchDelay)  │
                           └──────────────┬───────────────┘
                                          │
                                          ▼ (After 100ms quiet period)
                           ┌──────────────────────────────┐
                           │    syncEngine.sync()         │
                           │    (Single consolidated      │
                           │     sync for entire batch)   │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │  dispatch 'sync-complete'    │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │     SyncCoordinator          │
                           │     (SINGLE listener)        │
                           │                              │
                           │  1. Fetch updated photos     │
                           │  2. Compute delta            │
                           │  3. Match pending → real     │
                           │  4. Promote confirmed        │
                           │  5. Update PhotoStore        │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │       PhotoStore.setState    │
                           │  - addPhotos(newPhotos)      │
                           │  - promotePending(matches)   │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │   React Components           │
                           │   (Zustand auto-rerender)    │
                           │                              │
                           │   NO duplicate refetch!      │
                           │   Store drives all updates   │
                           └──────────────────────────────┘
```

---

## 4. Upload Lifecycle State Machine

### 4.1 State Diagram

```
                              ┌─────────────────────────────────────────────┐
                              │            UPLOAD STATE MACHINE              │
                              └─────────────────────────────────────────────┘

                                           ┌───────────┐
                                           │  QUEUED   │
                                           │ (hidden)  │
                                           └─────┬─────┘
                                                 │ add()
                                                 ▼
                                           ┌───────────┐
                                           │  PENDING  │
                                           │ (visible) │ Shows filename, progress=0
                                           └─────┬─────┘
                                                 │ processTask()
                                                 ▼
                                           ┌───────────┐
                                           │ UPLOADING │
                                           │ (visible) │ Shows thumbnail, progress bar
                                           └─────┬─────┘
                                                 │ onComplete()
                                                 ▼
                                        ┌────────────────┐
                                        │ MANIFEST_      │
                                        │ CREATING       │ Shows "Processing..."
                                        │ (visible)      │
                                        └───────┬────────┘
                                                │ manifest created
                                                ▼
                                        ┌────────────────┐
                                        │ AWAITING_SYNC  │
                                        │ (visible)      │ Shows "Syncing..."
                                        └───────┬────────┘
                                                │ sync-complete + match found
                                                ▼
                                        ┌────────────────┐
                                        │  CONFIRMED     │
                                        │ (promoted)     │ Replaced with real PhotoMeta
                                        └────────────────┘

                              Error Paths:
                              ┌───────────┐              ┌─────────────────┐
                              │ UPLOADING │──error──────►│ UPLOAD_FAILED   │
                              └───────────┘              │ (visible+error) │
                                                         └────────┬────────┘
                                                                  │ retry
                                                                  ▼
                                                         ┌─────────────────┐
                                                         │  RETRY_PENDING  │
                                                         │ (visible+retry) │
                                                         └─────────────────┘

                              ┌─────────────────┐              ┌─────────────────┐
                              │ MANIFEST_       │──error──────►│ MANIFEST_FAILED │
                              │ CREATING        │              │ (visible+error) │
                              └─────────────────┘              └─────────────────┘

                              ┌─────────────────┐
                              │ AWAITING_SYNC   │──timeout────►│ SYNC_TIMEOUT    │
                              │ (30s max)       │              │ (retry sync)    │
                              └─────────────────┘              └─────────────────┘
```

### 4.2 State Types

```typescript
// File: apps/admin/src/lib/upload-lifecycle.ts

/**
 * Upload lifecycle states with strict progression.
 * Each state determines visibility and UI treatment.
 */
export type UploadState =
  | 'queued'           // Added to queue, not yet started
  | 'pending'          // Started processing, visible as pending
  | 'uploading'        // Actively uploading chunks
  | 'manifest-creating'// Upload done, creating manifest
  | 'awaiting-sync'    // Manifest created, waiting for sync
  | 'confirmed'        // Sync confirmed photo exists on server
  | 'upload-failed'    // Upload failed (retryable)
  | 'manifest-failed'  // Manifest creation failed
  | 'sync-timeout';    // Sync took too long

/**
 * States where the upload should be visible in the photo grid
 */
export const VISIBLE_STATES: Set<UploadState> = new Set([
  'pending',
  'uploading',
  'manifest-creating',
  'awaiting-sync',
  'upload-failed',    // Show with error indicator
  'manifest-failed',  // Show with error indicator
  'sync-timeout',     // Show with retry indicator
]);

/**
 * States where the upload is still "in progress" (not terminal)
 */
export const IN_PROGRESS_STATES: Set<UploadState> = new Set([
  'queued',
  'pending',
  'uploading',
  'manifest-creating',
  'awaiting-sync',
]);

/**
 * Tracked upload with lifecycle state
 */
export interface TrackedUpload {
  /** Unique upload ID (same as task.id / assetId) */
  id: string;
  
  /** Current lifecycle state */
  state: UploadState;
  
  /** Album this upload belongs to */
  albumId: string;
  
  /** Original filename */
  filename: string;
  
  /** MIME type */
  mimeType: string;
  
  /** Upload progress (0-1) for uploading state */
  progress: number;
  
  /** Generated thumbnail (base64) */
  thumbnail?: string;
  
  /** Thumbnail dimensions */
  thumbWidth?: number;
  thumbHeight?: number;
  
  /** Original image dimensions */
  originalWidth?: number;
  originalHeight?: number;
  
  /** Epoch ID for this upload */
  epochId: number;
  
  /** Timestamp when upload started */
  startedAt: number;
  
  /** Error message if in failed state */
  error?: string;
  
  /** Retry count for failed uploads */
  retryCount: number;
}
```

---

## 5. Core Components

### 5.1 SyncRequestQueue (Debouncing/Coalescing)

```typescript
// File: apps/admin/src/lib/sync-request-queue.ts

import { syncEngine } from './sync-engine';
import { createLogger } from './logger';

const log = createLogger('sync-request-queue');

interface PendingSyncRequest {
  albumId: string;
  epochSeed?: Uint8Array;
  requestedAt: number;
}

/**
 * Debounced, coalesced sync request queue.
 * 
 * Key behaviors:
 * 1. Coalesces multiple sync requests for the same album
 * 2. Debounces with configurable delay (default 100ms)
 * 3. Waits for batch window when multiple uploads complete rapidly
 * 4. Executes single consolidated sync after quiet period
 */
class SyncRequestQueue {
  /** Pending requests by albumId (coalesced) */
  private pending = new Map<string, PendingSyncRequest>();
  
  /** Debounce timers by albumId */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  
  /** Debounce delay in milliseconds */
  private debounceMs = 100;
  
  /** Batch window: wait this long for more uploads to complete */
  private batchWindowMs = 200;
  
  /** Active sync promises for deduplication */
  private activeSync = new Map<string, Promise<void>>();
  
  /**
   * Request a sync for an album.
   * Multiple rapid requests are coalesced into one.
   * 
   * @param albumId - Album to sync
   * @param epochSeed - Optional epoch seed for decryption
   */
  requestSync(albumId: string, epochSeed?: Uint8Array): void {
    const now = Date.now();
    
    // Coalesce: update existing request or create new one
    const existing = this.pending.get(albumId);
    if (existing) {
      // Keep newer epoch seed if provided
      if (epochSeed) {
        existing.epochSeed = epochSeed;
      }
      log.debug(`Coalesced sync request for album ${albumId}`);
    } else {
      this.pending.set(albumId, {
        albumId,
        epochSeed,
        requestedAt: now,
      });
      log.debug(`Queued sync request for album ${albumId}`);
    }
    
    // Reset debounce timer
    this.resetTimer(albumId);
  }
  
  /**
   * Force immediate sync, bypassing debounce.
   * Use for critical operations like initial load.
   */
  async syncNow(albumId: string, epochSeed?: Uint8Array): Promise<void> {
    // Cancel any pending debounced request
    this.cancelTimer(albumId);
    this.pending.delete(albumId);
    
    await this.executeSync(albumId, epochSeed);
  }
  
  /**
   * Wait for any pending sync for an album to complete.
   * Returns immediately if no sync is pending.
   */
  async waitForSync(albumId: string): Promise<void> {
    const active = this.activeSync.get(albumId);
    if (active) {
      await active;
    }
  }
  
  /**
   * Check if there are pending sync requests for an album.
   */
  hasPending(albumId: string): boolean {
    return this.pending.has(albumId) || this.activeSync.has(albumId);
  }
  
  private resetTimer(albumId: string): void {
    this.cancelTimer(albumId);
    
    const timer = setTimeout(() => {
      this.executeQueuedSync(albumId);
    }, this.debounceMs);
    
    this.timers.set(albumId, timer);
  }
  
  private cancelTimer(albumId: string): void {
    const timer = this.timers.get(albumId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(albumId);
    }
  }
  
  private async executeQueuedSync(albumId: string): Promise<void> {
    const request = this.pending.get(albumId);
    if (!request) return;
    
    this.pending.delete(albumId);
    this.timers.delete(albumId);
    
    await this.executeSync(albumId, request.epochSeed);
  }
  
  private async executeSync(
    albumId: string,
    epochSeed?: Uint8Array
  ): Promise<void> {
    // Deduplicate concurrent syncs
    if (this.activeSync.has(albumId)) {
      log.debug(`Sync already active for album ${albumId}, waiting...`);
      await this.activeSync.get(albumId);
      return;
    }
    
    const syncPromise = (async () => {
      try {
        log.info(`Executing sync for album ${albumId}`);
        await syncEngine.sync(albumId, epochSeed);
        log.info(`Sync complete for album ${albumId}`);
      } catch (err) {
        log.error(`Sync failed for album ${albumId}:`, err);
        throw err;
      } finally {
        this.activeSync.delete(albumId);
      }
    })();
    
    this.activeSync.set(albumId, syncPromise);
    await syncPromise;
  }
  
  /**
   * Clear all pending requests (call on logout)
   */
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.timers.clear();
  }
}

/** Global sync request queue instance */
export const syncRequestQueue = new SyncRequestQueue();
```

---

### 5.2 UploadLifecycleManager

```typescript
// File: apps/admin/src/lib/upload-lifecycle-manager.ts

import { createLogger } from './logger';
import { syncRequestQueue } from './sync-request-queue';
import { uploadQueue, type UploadTask } from './upload-queue';
import type { TrackedUpload, UploadState } from './upload-lifecycle';

const log = createLogger('upload-lifecycle');

type StateChangeCallback = (upload: TrackedUpload) => void;
type ConfirmCallback = (uploadId: string, photoId: string) => void;

/**
 * Manages the complete lifecycle of uploads from queue to confirmation.
 * 
 * Key responsibilities:
 * 1. Track upload state transitions
 * 2. Keep pending items visible until server confirms
 * 3. Coordinate with sync queue for batched syncs
 * 4. Notify when uploads are confirmed
 */
class UploadLifecycleManager {
  /** Tracked uploads by ID */
  private uploads = new Map<string, TrackedUpload>();
  
  /** State change listeners */
  private stateListeners = new Set<StateChangeCallback>();
  
  /** Confirmation listeners (pending → real photo) */
  private confirmListeners = new Set<ConfirmCallback>();
  
  /** Uploads awaiting sync confirmation, keyed by assetId */
  private awaitingConfirmation = new Map<string, TrackedUpload>();
  
  /** Sync timeout handles */
  private syncTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  
  /** Maximum time to wait for sync confirmation (30 seconds) */
  private readonly SYNC_TIMEOUT_MS = 30000;
  
  /**
   * Initialize the lifecycle manager.
   * Sets up upload queue callbacks (single source of truth).
   */
  init(): void {
    // Register as THE upload queue handler (no competing handlers)
    uploadQueue.onProgress = this.handleProgress.bind(this);
    uploadQueue.onComplete = this.handleComplete.bind(this);
    uploadQueue.onError = this.handleError.bind(this);
    
    log.info('Upload lifecycle manager initialized');
  }
  
  /**
   * Start tracking a new upload.
   * Call this when adding to the upload queue.
   */
  trackUpload(
    taskId: string,
    albumId: string,
    file: File,
    epochId: number
  ): TrackedUpload {
    const upload: TrackedUpload = {
      id: taskId,
      state: 'pending',
      albumId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      progress: 0,
      epochId,
      startedAt: Date.now(),
      retryCount: 0,
    };
    
    this.uploads.set(taskId, upload);
    this.emitStateChange(upload);
    
    log.debug(`Tracking upload ${taskId}: ${file.name}`);
    return upload;
  }
  
  /**
   * Get a tracked upload by ID.
   */
  getUpload(id: string): TrackedUpload | undefined {
    return this.uploads.get(id);
  }
  
  /**
   * Get all uploads for an album.
   */
  getUploadsForAlbum(albumId: string): TrackedUpload[] {
    return Array.from(this.uploads.values())
      .filter((u) => u.albumId === albumId);
  }
  
  /**
   * Get all visible uploads (for UI display).
   */
  getVisibleUploads(albumId: string): TrackedUpload[] {
    return this.getUploadsForAlbum(albumId).filter((u) =>
      ['pending', 'uploading', 'manifest-creating', 'awaiting-sync',
       'upload-failed', 'manifest-failed', 'sync-timeout'].includes(u.state)
    );
  }
  
  /**
   * Subscribe to state changes.
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }
  
  /**
   * Subscribe to confirmation events.
   */
  onConfirm(callback: ConfirmCallback): () => void {
    this.confirmListeners.add(callback);
    return () => this.confirmListeners.delete(callback);
  }
  
  /**
   * Called when sync-complete fires.
   * Matches pending uploads to real photos and promotes them.
   * 
   * @param albumId - Album that was synced
   * @param serverPhotos - Photos from server (includes assetId for matching)
   */
  handleSyncComplete(
    albumId: string,
    serverPhotos: Array<{ id: string; assetId: string }>
  ): void {
    const awaiting = Array.from(this.awaitingConfirmation.values())
      .filter((u) => u.albumId === albumId);
    
    for (const upload of awaiting) {
      // Match by assetId (upload.id === photo.assetId)
      const matchingPhoto = serverPhotos.find((p) => p.assetId === upload.id);
      
      if (matchingPhoto) {
        log.info(`Confirmed upload ${upload.id} → photo ${matchingPhoto.id}`);
        
        // Clear timeout
        const timeout = this.syncTimeouts.get(upload.id);
        if (timeout) {
          clearTimeout(timeout);
          this.syncTimeouts.delete(upload.id);
        }
        
        // Transition to confirmed
        this.transitionState(upload.id, 'confirmed');
        this.awaitingConfirmation.delete(upload.id);
        
        // Notify listeners
        for (const listener of this.confirmListeners) {
          listener(upload.id, matchingPhoto.id);
        }
        
        // Remove from tracking (now a real photo)
        this.uploads.delete(upload.id);
      }
    }
  }
  
  /**
   * Retry a failed upload.
   */
  async retryUpload(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      log.warn(`Cannot retry unknown upload: ${uploadId}`);
      return;
    }
    
    if (!['upload-failed', 'manifest-failed', 'sync-timeout'].includes(upload.state)) {
      log.warn(`Cannot retry upload in state: ${upload.state}`);
      return;
    }
    
    // Reset to pending and increment retry count
    upload.retryCount++;
    upload.error = undefined;
    this.transitionState(uploadId, 'pending');
    
    // Re-trigger sync for sync-timeout
    if (upload.state === 'sync-timeout') {
      syncRequestQueue.requestSync(upload.albumId);
    }
    
    // For upload/manifest failures, the upload queue handles retry
  }
  
  /**
   * Cancel and remove an upload.
   */
  async cancelUpload(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    
    // Cancel in upload queue
    await uploadQueue.cancel(uploadId);
    
    // Clear any pending timeouts
    const timeout = this.syncTimeouts.get(uploadId);
    if (timeout) {
      clearTimeout(timeout);
      this.syncTimeouts.delete(uploadId);
    }
    
    // Remove from tracking
    this.uploads.delete(uploadId);
    this.awaitingConfirmation.delete(uploadId);
    
    log.debug(`Cancelled upload ${uploadId}`);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // Internal Handlers
  // ─────────────────────────────────────────────────────────────────────────
  
  private handleProgress(task: UploadTask): void {
    const upload = this.uploads.get(task.id);
    if (!upload) return;
    
    // Update progress and thumbnail info
    upload.progress = task.progress;
    if (task.thumbnailBase64) {
      upload.thumbnail = task.thumbnailBase64;
      upload.thumbWidth = task.thumbWidth;
      upload.thumbHeight = task.thumbHeight;
    }
    if (task.originalWidth) {
      upload.originalWidth = task.originalWidth;
      upload.originalHeight = task.originalHeight;
    }
    
    // Transition to uploading if still pending
    if (upload.state === 'pending') {
      this.transitionState(task.id, 'uploading');
    } else {
      this.emitStateChange(upload);
    }
  }
  
  private async handleComplete(
    task: UploadTask,
    shardIds: string[]
  ): Promise<void> {
    const upload = this.uploads.get(task.id);
    if (!upload) {
      log.warn(`Complete callback for unknown upload: ${task.id}`);
      return;
    }
    
    // Transition to manifest-creating
    this.transitionState(task.id, 'manifest-creating');
    
    try {
      // Create the manifest
      await this.createManifest(task, shardIds);
      
      // Transition to awaiting-sync
      this.transitionState(task.id, 'awaiting-sync');
      this.awaitingConfirmation.set(task.id, upload);
      
      // Set sync timeout
      const timeout = setTimeout(() => {
        this.handleSyncTimeout(task.id);
      }, this.SYNC_TIMEOUT_MS);
      this.syncTimeouts.set(task.id, timeout);
      
      // Request sync (will be debounced/coalesced)
      syncRequestQueue.requestSync(task.albumId);
      
    } catch (err) {
      log.error(`Manifest creation failed for ${task.id}:`, err);
      upload.error = err instanceof Error ? err.message : String(err);
      this.transitionState(task.id, 'manifest-failed');
    }
  }
  
  private handleError(task: UploadTask, error: Error): void {
    const upload = this.uploads.get(task.id);
    if (!upload) return;
    
    upload.error = error.message;
    this.transitionState(task.id, 'upload-failed');
  }
  
  private handleSyncTimeout(uploadId: string): void {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.state !== 'awaiting-sync') return;
    
    log.warn(`Sync timeout for upload ${uploadId}`);
    this.transitionState(uploadId, 'sync-timeout');
    
    // Auto-retry sync once
    if (upload.retryCount < 2) {
      upload.retryCount++;
      syncRequestQueue.requestSync(upload.albumId);
      
      // Reset to awaiting-sync with new timeout
      this.transitionState(uploadId, 'awaiting-sync');
      const timeout = setTimeout(() => {
        this.handleSyncTimeout(uploadId);
      }, this.SYNC_TIMEOUT_MS);
      this.syncTimeouts.set(uploadId, timeout);
    }
  }
  
  private async createManifest(
    task: UploadTask,
    shardIds: string[]
  ): Promise<void> {
    // Import dynamically to avoid circular dependency
    const { createManifestForUpload } = await import('./manifest-creator');
    const { getCurrentOrFetchEpochKey } = await import('./epoch-key-service');
    
    const epochKey = await getCurrentOrFetchEpochKey(task.albumId);
    await createManifestForUpload(task, shardIds, epochKey);
  }
  
  private transitionState(uploadId: string, newState: UploadState): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    
    const oldState = upload.state;
    upload.state = newState;
    
    log.debug(`Upload ${uploadId}: ${oldState} → ${newState}`);
    this.emitStateChange(upload);
  }
  
  private emitStateChange(upload: TrackedUpload): void {
    for (const listener of this.stateListeners) {
      listener({ ...upload }); // Shallow copy for immutability
    }
  }
  
  /**
   * Clear all tracked uploads (call on logout)
   */
  clear(): void {
    for (const timeout of this.syncTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.uploads.clear();
    this.awaitingConfirmation.clear();
    this.syncTimeouts.clear();
  }
}

/** Global upload lifecycle manager instance */
export const uploadLifecycleManager = new UploadLifecycleManager();
```

---

### 5.3 SyncCoordinator (Single Listener)

```typescript
// File: apps/admin/src/lib/sync-coordinator.ts

import { getDbClient } from './db-client';
import { createLogger } from './logger';
import { syncEngine, type SyncEventDetail } from './sync-engine';
import { uploadLifecycleManager } from './upload-lifecycle-manager';

const log = createLogger('sync-coordinator');

/**
 * Singleton sync coordinator.
 * 
 * THE ONLY component that listens to sync-complete events.
 * All other components subscribe to PhotoStore for updates.
 */
class SyncCoordinator {
  private initialized = false;
  private cleanupFn: (() => void) | null = null;
  
  /**
   * Initialize the coordinator.
   * Call once at app startup.
   */
  init(): void {
    if (this.initialized) {
      log.warn('SyncCoordinator already initialized');
      return;
    }
    
    const handleSyncComplete = async (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      await this.handleSyncComplete(detail.albumId);
    };
    
    syncEngine.addEventListener('sync-complete', handleSyncComplete);
    this.cleanupFn = () => {
      syncEngine.removeEventListener('sync-complete', handleSyncComplete);
    };
    
    this.initialized = true;
    log.info('SyncCoordinator initialized (single sync-complete listener)');
  }
  
  /**
   * Dispose the coordinator.
   * Call on app shutdown.
   */
  dispose(): void {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
    this.initialized = false;
    log.info('SyncCoordinator disposed');
  }
  
  /**
   * Handle sync-complete for an album.
   * This is THE ONLY handler for sync-complete events.
   */
  private async handleSyncComplete(albumId: string): Promise<void> {
    try {
      const db = await getDbClient();
      
      // Fetch updated photos from local DB
      const photos = await db.getPhotos(albumId, 1000, 0);
      
      // Match pending uploads to real photos
      // Photos have assetId field that matches upload task ID
      const photoMatches = photos.map((p) => ({
        id: p.id,
        assetId: p.assetId,
      }));
      
      // Notify lifecycle manager to promote confirmed uploads
      uploadLifecycleManager.handleSyncComplete(albumId, photoMatches);
      
      // Update PhotoStore with new data
      // (PhotoStore subscription drives React updates - no manual refetch needed)
      const { usePhotoStore } = await import('../stores/photo-store');
      const store = usePhotoStore.getState();
      const version = await db.getAlbumVersion(albumId);
      
      // Compute delta and apply incremental updates
      const albumState = store.albums.get(albumId);
      if (!albumState || albumState.photos.size === 0) {
        // Initial load
        store.setPhotos(albumId, photos, version);
      } else {
        // Incremental update
        const delta = computeDelta(albumState.photos, photos);
        
        if (delta.added.length > 0) {
          store.addPhotos(albumId, delta.added);
        }
        if (delta.removed.length > 0) {
          store.removePhotos(albumId, delta.removed);
        }
        for (const photo of delta.updated) {
          store.updatePhoto(albumId, photo.id, photo);
        }
      }
      
      log.debug(`Processed sync-complete for album ${albumId}: ${photos.length} photos`);
    } catch (err) {
      log.error(`Failed to handle sync-complete for album ${albumId}:`, err);
    }
  }
}

/**
 * Compute delta between old and new photo sets.
 */
function computeDelta(
  oldPhotos: Map<string, PhotoMeta>,
  newPhotos: PhotoMeta[]
): { added: PhotoMeta[]; removed: string[]; updated: PhotoMeta[] } {
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

// Import type for delta computation
import type { PhotoMeta } from '../workers/types';

/** Global sync coordinator instance */
export const syncCoordinator = new SyncCoordinator();
```

---

## 6. Migration Plan

### 6.1 Files to Modify

| File | Change |
|------|--------|
| [Gallery.tsx](../../apps/admin/src/components/Gallery/Gallery.tsx) | **REMOVE** sync-complete listener (lines 138-150) |
| [EnhancedMosaicPhotoGrid.tsx](../../apps/admin/src/components/Gallery/EnhancedMosaicPhotoGrid.tsx) | **REMOVE** sync-complete listener (lines 218-223) |
| [UploadContext.tsx](../../apps/admin/src/contexts/UploadContext.tsx) | **REMOVE** onComplete/onError handlers, use lifecycle manager |
| [useUpload.ts](../../apps/admin/src/hooks/useUpload.ts) | **REMOVE** onComplete/onError handlers, use lifecycle manager |
| [main.tsx](../../apps/admin/src/main.tsx) | **ADD** initialization of syncCoordinator and uploadLifecycleManager |

### 6.2 New Files

| File | Purpose |
|------|---------|
| `src/lib/sync-request-queue.ts` | Debounced/coalesced sync queue |
| `src/lib/upload-lifecycle.ts` | Upload state types and constants |
| `src/lib/upload-lifecycle-manager.ts` | Upload state machine |
| `src/lib/sync-coordinator.ts` | Single sync-complete listener |
| `src/stores/photo-store.ts` | Zustand store for photos |
| `src/hooks/usePhotoList.ts` | Selector hook for photo list |

### 6.3 Initialization Order

```typescript
// File: apps/admin/src/main.tsx

import { syncCoordinator } from './lib/sync-coordinator';
import { uploadLifecycleManager } from './lib/upload-lifecycle-manager';

// Initialize in correct order
uploadLifecycleManager.init();  // Sets up upload queue callbacks
syncCoordinator.init();          // Sets up sync-complete listener

// Cleanup on unmount/HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    syncCoordinator.dispose();
    uploadLifecycleManager.clear();
  });
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

```typescript
// File: apps/admin/tests/sync-request-queue.test.ts

describe('SyncRequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    syncRequestQueue.clear();
  });

  it('should coalesce multiple requests for same album', async () => {
    const syncSpy = vi.spyOn(syncEngine, 'sync').mockResolvedValue();

    syncRequestQueue.requestSync('album-1');
    syncRequestQueue.requestSync('album-1');
    syncRequestQueue.requestSync('album-1');

    // Fast-forward past debounce
    await vi.advanceTimersByTimeAsync(150);

    // Should only sync once
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith('album-1', undefined);
  });

  it('should debounce rapid requests', async () => {
    const syncSpy = vi.spyOn(syncEngine, 'sync').mockResolvedValue();

    // Request sync
    syncRequestQueue.requestSync('album-1');

    // Wait 50ms (less than debounce)
    await vi.advanceTimersByTimeAsync(50);
    expect(syncSpy).not.toHaveBeenCalled();

    // Request again (resets debounce)
    syncRequestQueue.requestSync('album-1');

    // Wait 50ms more
    await vi.advanceTimersByTimeAsync(50);
    expect(syncSpy).not.toHaveBeenCalled();

    // Wait for full debounce
    await vi.advanceTimersByTimeAsync(100);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('should handle different albums independently', async () => {
    const syncSpy = vi.spyOn(syncEngine, 'sync').mockResolvedValue();

    syncRequestQueue.requestSync('album-1');
    syncRequestQueue.requestSync('album-2');

    await vi.advanceTimersByTimeAsync(150);

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenCalledWith('album-1', undefined);
    expect(syncSpy).toHaveBeenCalledWith('album-2', undefined);
  });
});
```

### 7.2 Upload Lifecycle Tests

```typescript
// File: apps/admin/tests/upload-lifecycle-manager.test.ts

describe('UploadLifecycleManager', () => {
  beforeEach(() => {
    uploadLifecycleManager.init();
  });

  afterEach(() => {
    uploadLifecycleManager.clear();
  });

  it('should track upload through full lifecycle', async () => {
    const states: UploadState[] = [];
    uploadLifecycleManager.onStateChange((upload) => {
      states.push(upload.state);
    });

    // Track new upload
    const upload = uploadLifecycleManager.trackUpload(
      'task-1',
      'album-1',
      new File(['test'], 'test.jpg'),
      1
    );
    expect(upload.state).toBe('pending');

    // Simulate progress
    uploadQueue.onProgress!({
      id: 'task-1',
      progress: 0.5,
      // ... other fields
    } as UploadTask);
    expect(states).toContain('uploading');

    // Simulate complete → manifest creation → awaiting sync
    // ... (full lifecycle test)
  });

  it('should keep upload visible until sync confirms', async () => {
    uploadLifecycleManager.trackUpload(
      'task-1',
      'album-1',
      new File(['test'], 'test.jpg'),
      1
    );

    // Simulate upload complete + manifest created
    // ... transition to 'awaiting-sync'

    // Should still be visible
    const visible = uploadLifecycleManager.getVisibleUploads('album-1');
    expect(visible).toHaveLength(1);

    // Simulate sync-complete with matching photo
    uploadLifecycleManager.handleSyncComplete('album-1', [
      { id: 'photo-1', assetId: 'task-1' },
    ]);

    // Should no longer be tracked (promoted to real photo)
    expect(uploadLifecycleManager.getUpload('task-1')).toBeUndefined();
  });

  it('should handle sync timeout and auto-retry', async () => {
    vi.useFakeTimers();

    uploadLifecycleManager.trackUpload(
      'task-1',
      'album-1',
      new File(['test'], 'test.jpg'),
      1
    );

    // Simulate reaching awaiting-sync state
    // ...

    // Fast-forward past timeout
    await vi.advanceTimersByTimeAsync(31000);

    const upload = uploadLifecycleManager.getUpload('task-1');
    expect(upload?.retryCount).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});
```

### 7.3 Integration Test

```typescript
// File: apps/admin/tests/sync-coordination-integration.test.ts

describe('Sync Coordination Integration', () => {
  it('should handle batch upload with single consolidated sync', async () => {
    const syncSpy = vi.spyOn(syncEngine, 'sync').mockResolvedValue();

    // Upload 5 files rapidly
    for (let i = 0; i < 5; i++) {
      await uploadQueue.add(
        new File(['test'], `file-${i}.jpg`),
        'album-1',
        1,
        new Uint8Array(32)
      );
    }

    // Wait for all uploads to complete and sync to be triggered
    await vi.waitFor(() => {
      expect(syncSpy).toHaveBeenCalled();
    });

    // Should only have synced ONCE (coalesced)
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('should not have duplicate refetch from components', async () => {
    const dbQuerySpy = vi.spyOn(db, 'getPhotos');

    // Trigger sync-complete
    syncEngine.dispatchEvent(
      new CustomEvent('sync-complete', {
        detail: { albumId: 'album-1' },
      })
    );

    await vi.waitFor(() => {
      expect(dbQuerySpy).toHaveBeenCalled();
    });

    // Should only query ONCE (single coordinator, no component listeners)
    expect(dbQuerySpy).toHaveBeenCalledTimes(1);
  });
});
```

---

## 8. Summary of Fixes

| Race Condition | Fix |
|----------------|-----|
| **Dual Listeners** | Remove all component-level `sync-complete` listeners. SyncCoordinator is the ONLY listener. Components subscribe to PhotoStore via Zustand selectors. |
| **Batch Upload Sync Collision** | SyncRequestQueue debounces and coalesces sync requests. Multiple uploads trigger ONE consolidated sync after 100ms quiet period. |
| **Premature Pending Removal** | UploadLifecycleManager keeps uploads in `awaiting-sync` state until SyncCoordinator confirms the photo exists in server response. |
| **Competing onComplete Handlers** | UploadLifecycleManager is the ONLY handler for upload queue callbacks. No duplicate handlers. |

---

## 9. Verification Checklist

- [ ] Only ONE `sync-complete` listener exists (in SyncCoordinator)
- [ ] Multiple rapid sync requests produce single sync call
- [ ] Pending uploads remain visible during sync
- [ ] Pending → real transition only on server confirmation
- [ ] Batch uploads result in single consolidated sync
- [ ] No duplicate database queries on sync-complete
- [ ] Sync timeout triggers retry (not failure)
- [ ] All upload states have clear UI representation
