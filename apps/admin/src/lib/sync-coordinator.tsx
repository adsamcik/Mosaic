/**
 * SyncCoordinator - Single sync-complete event listener
 *
 * THE ONLY component that listens to sync-complete events.
 * All other components subscribe to PhotoStore for reactive updates.
 *
 * Responsibilities:
 * 1. Single listener for sync-complete events (eliminates dual listener race)
 * 2. Debounce rapid sync events (100ms)
 * 3. Fetch fresh data from local DB on sync-complete
 * 4. Compute delta between current and new data
 * 5. Match pending items by assetId to promote them
 * 6. Update PhotoStore with incremental changes
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { getDbClient } from './db-client';
import { createLogger } from './logger';
import { syncEngine, type SyncEventDetail } from './sync-engine';
import { usePhotoStore, type PhotoItem } from '../stores/photo-store';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('sync-coordinator');

/** Debounce delay in milliseconds */
const DEBOUNCE_MS = 100;

/** Sync timeout for pending items (ms) - items awaiting promotion */
const SYNC_TIMEOUT_MS = 30_000;

/**
 * Pending item awaiting sync confirmation
 */
interface PendingSync {
  albumId: string;
  assetId: string;
  timeoutId: ReturnType<typeof setTimeout>;
  addedAt: number;
}

/**
 * Delta between old and new photo sets
 */
interface PhotoDelta {
  added: PhotoMeta[];
  removed: string[];
  updated: PhotoMeta[];
  promoted: Array<{ assetId: string; photo: PhotoMeta }>;
}

/**
 * SyncCoordinator singleton class
 */
class SyncCoordinator {
  private initialized = false;
  private cleanupFn: (() => void) | null = null;

  /** Debounce timers per album */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Pending items awaiting sync confirmation */
  private pendingSyncs = new Map<string, PendingSync>();

  /**
   * Initialize the coordinator.
   * Call once at app startup.
   */
  init(): void {
    if (this.initialized) {
      log.warn('SyncCoordinator already initialized');
      return;
    }

    const handleSyncComplete = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      this.debouncedHandleSyncComplete(detail.albumId);
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
   * Call on app shutdown or logout.
   */
  dispose(): void {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear all pending sync timeouts
    for (const pending of this.pendingSyncs.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingSyncs.clear();

    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }

    this.initialized = false;
    log.info('SyncCoordinator disposed');
  }

  /**
   * Register a pending upload awaiting sync confirmation.
   * Called by upload queue when upload completes successfully.
   *
   * @param albumId - Album the photo was uploaded to
   * @param assetId - Asset ID (matches the pending item in PhotoStore)
   */
  registerPendingSync(albumId: string, assetId: string): void {
    const key = `${albumId}:${assetId}`;

    // Clear existing timeout if re-registering
    const existing = this.pendingSyncs.get(key);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    // Set timeout for sync confirmation
    const timeoutId = setTimeout(() => {
      this.handleSyncTimeout(albumId, assetId);
    }, SYNC_TIMEOUT_MS);

    this.pendingSyncs.set(key, {
      albumId,
      assetId,
      timeoutId,
      addedAt: Date.now(),
    });

    log.debug(`Registered pending sync: ${key}`);
  }

  /**
   * Cancel a pending sync registration.
   * Called when upload is cancelled or fails.
   */
  cancelPendingSync(albumId: string, assetId: string): void {
    const key = `${albumId}:${assetId}`;
    const pending = this.pendingSyncs.get(key);

    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingSyncs.delete(key);
      log.debug(`Cancelled pending sync: ${key}`);
    }
  }

  /**
   * Handle sync timeout for a pending item.
   * If sync-complete hasn't confirmed the item, trigger manual sync.
   */
  private handleSyncTimeout(albumId: string, assetId: string): void {
    const key = `${albumId}:${assetId}`;
    const pending = this.pendingSyncs.get(key);

    if (!pending) return;

    this.pendingSyncs.delete(key);

    log.warn(
      `Sync timeout for ${key} - item not confirmed after ${SYNC_TIMEOUT_MS}ms`,
    );

    // Check if item is still pending/syncing in store
    const store = usePhotoStore.getState();
    const photo = store.getPhoto(albumId, assetId);

    if (photo && (photo.status === 'pending' || photo.status === 'syncing')) {
      // Mark as failed - user can retry
      store.markUploadFailed(albumId, assetId, 'Sync confirmation timeout');
    }
  }

  /**
   * Debounced handler for sync-complete events.
   * Coalesces rapid sync events within DEBOUNCE_MS.
   */
  private debouncedHandleSyncComplete(albumId: string): void {
    // Clear existing debounce timer for this album
    const existing = this.debounceTimers.get(albumId);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(albumId);
      void this.handleSyncComplete(albumId);
    }, DEBOUNCE_MS);

    this.debounceTimers.set(albumId, timer);
  }

  /**
   * Handle sync-complete for an album.
   * This is THE ONLY handler for sync-complete events.
   */
  private async handleSyncComplete(albumId: string): Promise<void> {
    log.info(`handleSyncComplete called for album ${albumId}`);

    try {
      const db = await getDbClient();
      const store = usePhotoStore.getState();

      // Ensure album is initialized
      store.initAlbum(albumId);

      // Fetch all photos from local DB
      // Using a large limit - in production, implement pagination
      const photos = await db.getPhotos(albumId, 10000, 0);
      log.info(
        `Found ${photos.length} photos in local DB for album ${albumId}`,
      );

      // Get current album state
      const albumState = store.albums.get(albumId);
      if (!albumState) {
        log.warn(`Album ${albumId} not found in store after init`);
        return;
      }

      // Log pending items
      const pendingItems = Array.from(albumState.items.values()).filter(
        (i) => i.status === 'pending' || i.status === 'syncing',
      );
      log.info(
        `Album ${albumId} has ${pendingItems.length} pending/syncing items`,
      );

      // Compute delta and find promotions
      const delta = this.computeDelta(albumId, albumState.items, photos);

      // Apply incremental updates
      this.applyDelta(albumId, delta, store);

      log.info(
        `Processed sync-complete for album ${albumId}: ` +
          `${delta.added.length} added, ${delta.removed.length} removed, ` +
          `${delta.updated.length} updated, ${delta.promoted.length} promoted`,
      );
    } catch (err) {
      log.error(`Failed to handle sync-complete for album ${albumId}:`, err);
    }
  }

  /**
   * Compute delta between current store state and new photos from DB.
   * Identifies added, removed, updated photos and pending items to promote.
   */
  private computeDelta(
    albumId: string,
    currentItems: Map<string, PhotoItem>,
    newPhotos: PhotoMeta[],
  ): PhotoDelta {
    const newPhotoMap = new Map(newPhotos.map((p) => [p.id, p]));

    const added: PhotoMeta[] = [];
    const updated: PhotoMeta[] = [];
    const removed: string[] = [];
    const promoted: Array<{ assetId: string; photo: PhotoMeta }> = [];

    // Track which assetIds are pending/syncing for promotion matching
    const pendingAssetIds = new Map<string, PhotoItem>();
    for (const [, item] of currentItems) {
      if (item.status === 'pending' || item.status === 'syncing') {
        pendingAssetIds.set(item.assetId, item);
      }
    }

    log.info(
      `computeDelta: ${pendingAssetIds.size} pending items, ${newPhotos.length} photos from DB`,
    );
    if (pendingAssetIds.size > 0) {
      log.info(
        `Pending assetIds: ${Array.from(pendingAssetIds.keys()).join(', ')}`,
      );
    }
    if (newPhotos.length > 0) {
      log.info(
        `DB photo assetIds: ${newPhotos.map((p) => p.assetId ?? 'null').join(', ')}`,
      );
    }

    // Process new photos
    for (const photo of newPhotos) {
      const existing = currentItems.get(photo.id);

      // Check if this photo matches a pending upload by assetId
      const pendingItem = pendingAssetIds.get(photo.assetId);
      if (pendingItem) {
        // This is a promotion - pending item confirmed by server
        log.info(
          `PROMOTION MATCH: assetId=${photo.assetId} matched pending item`,
        );
        promoted.push({ assetId: photo.assetId, photo });

        // Clear the sync timeout for this item
        this.clearPendingSyncTimeout(albumId, photo.assetId);

        continue;
      }

      if (!existing) {
        // New photo from server (not from our upload)
        added.push(photo);
      } else if (existing.status === 'stable') {
        // Check if updated (compare timestamps)
        const existingTime = existing.createdAt?.toISOString();
        if (photo.updatedAt !== existingTime) {
          updated.push(photo);
        }
      }
      // Skip if deleting - don't resurrect items being deleted
    }

    // Find removed photos (in store but not in DB, and status is stable)
    for (const [id, item] of currentItems) {
      if (item.status === 'stable' && !newPhotoMap.has(id)) {
        removed.push(id);
      }
    }

    return { added, removed, updated, promoted };
  }

  /**
   * Apply computed delta to the PhotoStore.
   */
  private applyDelta(
    albumId: string,
    delta: PhotoDelta,
    store: ReturnType<typeof usePhotoStore.getState>,
  ): void {
    // Process promotions first - transition pending/syncing → stable
    for (const { assetId, photo } of delta.promoted) {
      const promotionData: Pick<
        PhotoItem,
        'encryptedMetadata' | 'thumbnailUrl' | 'createdAt'
      > = {
        createdAt: new Date(photo.createdAt),
      };

      if (photo.thumbnail) {
        promotionData.thumbnailUrl = `data:image/jpeg;base64,${photo.thumbnail}`;
      }

      store.promoteToStable(albumId, assetId, promotionData);
    }

    // Process new photos (from other clients or server)
    for (const photo of delta.added) {
      // Add via proper store action to avoid Immer mutation errors
      const thumbnailUrl = photo.thumbnail
        ? `data:image/jpeg;base64,${photo.thumbnail}`
        : undefined;

      store.addStableFromServer(
        albumId,
        photo.assetId,
        thumbnailUrl,
        new Date(photo.createdAt),
      );
    }

    // Process removed photos
    for (const photoId of delta.removed) {
      store.confirmDeleted(albumId, photoId);
    }

    // Process updates - refresh metadata for existing stable items
    for (const photo of delta.updated) {
      const thumbnailUrl = photo.thumbnail
        ? `data:image/jpeg;base64,${photo.thumbnail}`
        : undefined;

      store.updatePhotoFromServer(
        albumId,
        photo.assetId,
        thumbnailUrl,
        new Date(photo.createdAt),
      );
    }
  }

  /**
   * Clear sync timeout for a specific pending item.
   */
  private clearPendingSyncTimeout(albumId: string, assetId: string): void {
    const key = `${albumId}:${assetId}`;
    const pending = this.pendingSyncs.get(key);

    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingSyncs.delete(key);
      log.debug(`Cleared pending sync timeout: ${key}`);
    }
  }

  /**
   * Get count of pending syncs (for monitoring/debugging)
   */
  getPendingSyncCount(): number {
    return this.pendingSyncs.size;
  }

  /**
   * Check if coordinator is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/** Global sync coordinator singleton instance */
export const syncCoordinator = new SyncCoordinator();

// ============================================================================
// React Provider (optional - for components that need to trigger manual syncs)
// ============================================================================

interface SyncCoordinatorContextValue {
  registerPendingSync: (albumId: string, assetId: string) => void;
  cancelPendingSync: (albumId: string, assetId: string) => void;
}

const SyncCoordinatorContext =
  createContext<SyncCoordinatorContextValue | null>(null);

interface SyncCoordinatorProviderProps {
  children: ReactNode;
}

/**
 * React Provider for SyncCoordinator.
 * Initializes the coordinator on mount.
 * Note: We do NOT dispose on unmount because:
 * 1. SyncCoordinator is a singleton that survives navigation
 * 2. Debounce timers must complete even if user navigates away
 * 3. Dispose is only called on logout via session.logout()
 */
export function SyncCoordinatorProvider({
  children,
}: SyncCoordinatorProviderProps): ReactNode {
  useEffect(() => {
    syncCoordinator.init();

    // Note: No cleanup - singleton survives navigation
    // Dispose is called explicitly on logout
  }, []);

  const value: SyncCoordinatorContextValue = {
    registerPendingSync: (albumId, assetId) =>
      syncCoordinator.registerPendingSync(albumId, assetId),
    cancelPendingSync: (albumId, assetId) =>
      syncCoordinator.cancelPendingSync(albumId, assetId),
  };

  return (
    <SyncCoordinatorContext.Provider value={value}>
      {children}
    </SyncCoordinatorContext.Provider>
  );
}

/**
 * Hook to access SyncCoordinator functions from React components.
 * Throws if used outside of SyncCoordinatorProvider.
 */
export function useSyncCoordinator(): SyncCoordinatorContextValue {
  const context = useContext(SyncCoordinatorContext);

  if (!context) {
    throw new Error(
      'useSyncCoordinator must be used within a SyncCoordinatorProvider',
    );
  }

  return context;
}

/**
 * Hook to safely access SyncCoordinator (returns null if not in provider).
 * Use this for optional sync coordinator integration.
 */
export function useSyncCoordinatorOptional(): SyncCoordinatorContextValue | null {
  return useContext(SyncCoordinatorContext);
}
