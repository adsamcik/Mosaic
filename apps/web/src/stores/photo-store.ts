import { create } from 'zustand';
import { mutative } from 'zustand-mutative';

// ============================================================================
// Types
// ============================================================================

/**
 * `failed_permanent` is a terminal status for uploads that exhausted all
 * retries (max-retries permanent failure). It is intentionally NOT part
 * of `pending|syncing` so pending-count, waitForSync()-style observers,
 * and sync-coordinator retry loops do not block on items that will never
 * complete on their own. The item remains visible in the gallery with
 * `item.error` set so the user can either dismiss or trigger an explicit
 * retry (`retryUploadInStore`).
 *
 * See v1.0.2 todo `v102-permanent-failures-leave-pending`.
 */
export type PhotoStatus =
  | 'stable'
  | 'pending'
  | 'syncing'
  | 'deleting'
  | 'failed_permanent';

/** Current action during upload */
export type UploadAction =
  | 'waiting'
  | 'converting'
  | 'encrypting'
  | 'uploading'
  | 'finalizing';

export interface PhotoItem {
  assetId: string;
  albumId: string;
  status: PhotoStatus;

  // Metadata (available for stable/syncing items)
  encryptedMetadata?: Uint8Array;
  thumbnailUrl?: string;
  createdAt?: Date;

  // Pending-specific fields
  localBlobUrl?: string;
  uploadProgress?: number;
  uploadAction?: UploadAction;
  error?: string;

  // For optimistic delete recovery
  previousStatus?: PhotoStatus;
}

export type FetchStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * Promotion data buffered for an asset whose `promoteToStable` arrived
 * before `addPending`. When a late `addPending` lands for the same asset,
 * the intent is consumed and the item is inserted directly as 'stable',
 * preventing an orphan pending entry that would otherwise stay forever.
 *
 * See v1.0.x release blocker `validation-final-gate-isolated-v3-04`.
 */
export interface LatePromoteIntent {
  promotionData: Pick<
    PhotoItem,
    'encryptedMetadata' | 'thumbnailUrl' | 'createdAt'
  >;
  expiresAt: number;
}

/** Time-to-live for a buffered late-promote intent. */
export const LATE_PROMOTE_TTL_MS = 30_000;

/**
 * Hard ceiling on buffered late-promote intents per album. When this
 * limit is hit, the oldest intent (insertion order) is evicted FIFO
 * before the new one is inserted. Prevents unbounded growth on
 * inactive albums where TTL-based opportunistic pruning never runs
 * (v1.0.2 todo `v102-latepromote-intent-ttl-sweep`).
 */
export const MAX_INTENTS_PER_ALBUM = 1000;

export interface AlbumPhotoState {
  items: Map<string, PhotoItem>;
  /** Promotions awaiting a late-arriving `addPending`. Keyed by assetId. */
  latePromoteIntents: Map<string, LatePromoteIntent>;
  fetchStatus: FetchStatus;
  fetchError: string | undefined;
  hasMore: boolean;
  cursor: string | undefined;
}

export interface PhotoStoreState {
  albums: Map<string, AlbumPhotoState>;
  activeAlbumId: string | null;
}

export interface PhotoStoreActions {
  // Album management
  initAlbum: (albumId: string) => void;
  setActiveAlbum: (albumId: string | null) => void;
  purgeAlbum: (albumId: string) => void;

  // Fetch lifecycle
  startFetch: (albumId: string) => void;
  completeFetch: (
    albumId: string,
    items: Array<Omit<PhotoItem, 'status' | 'albumId'>>,
    cursor?: string,
    hasMore?: boolean,
  ) => void;
  failFetch: (albumId: string, error: string) => void;

  // Pending upload lifecycle
  addPending: (albumId: string, assetId: string, localBlobUrl: string) => void;
  updateProgress: (
    albumId: string,
    assetId: string,
    progress: number,
    action?: UploadAction,
  ) => void;
  transitionToSyncing: (albumId: string, assetId: string) => void;
  promoteToStable: (
    albumId: string,
    assetId: string,
    metadata: Pick<
      PhotoItem,
      'encryptedMetadata' | 'thumbnailUrl' | 'createdAt'
    >,
  ) => void;
  markUploadFailed: (
    albumId: string,
    assetId: string,
    error: string,
    permanent?: boolean,
  ) => void;
  removePending: (albumId: string, assetId: string) => void;
  /**
   * Reset a `failed_permanent` item back to `pending` so a user-driven
   * retry can re-run the normal upload lifecycle. No-op if the item is
   * not in `failed_permanent`.
   */
  resetForRetry: (albumId: string, assetId: string) => void;
  /**
   * Active-sweep entry point: prunes TTL-expired late-promote intents
   * across every album. Designed to be invoked from a periodic timer
   * so memory does not grow unbounded on inactive albums whose
   * `addPending` / `promoteToStable` paths (which prune opportunistically)
   * never run. See v1.0.2 todo `v102-latepromote-intent-ttl-sweep`.
   */
  pruneAllLatePromoteIntents: () => void;

  // Delete lifecycle
  markDeleting: (albumId: string, assetId: string) => void;
  confirmDeleted: (albumId: string, assetId: string) => void;
  revertDelete: (albumId: string, assetId: string) => void;

  // Server sync lifecycle (from sync-coordinator)
  addStableFromServer: (
    albumId: string,
    assetId: string,
    thumbnailUrl?: string,
    createdAt?: Date,
  ) => void;
  updatePhotoFromServer: (
    albumId: string,
    assetId: string,
    thumbnailUrl?: string,
    createdAt?: Date,
  ) => void;

  // Selectors
  getAlbumState: (albumId: string) => AlbumPhotoState | undefined;
  getPhoto: (albumId: string, assetId: string) => PhotoItem | undefined;
  getPhotosByStatus: (albumId: string, status: PhotoStatus) => PhotoItem[];
  getSortedPhotoList: (albumId: string) => PhotoItem[];
}

export type PhotoStore = PhotoStoreState & PhotoStoreActions;

// ============================================================================
// Initial State
// ============================================================================

const createInitialAlbumState = (): AlbumPhotoState => ({
  items: new Map(),
  latePromoteIntents: new Map(),
  fetchStatus: 'idle',
  hasMore: true,
  cursor: undefined,
  fetchError: undefined,
});

/** Drop any intents whose TTL has elapsed. */
function pruneStaleIntents(
  intents: Map<string, LatePromoteIntent>,
  now: number,
): void {
  for (const [id, intent] of intents) {
    if (intent.expiresAt <= now) {
      intents.delete(id);
    }
  }
}

const initialState: PhotoStoreState = {
  albums: new Map(),
  activeAlbumId: null,
};

// ============================================================================
// Store Implementation
// ============================================================================

export const usePhotoStore = create<PhotoStore>()(
  mutative((set, get) => ({
    ...initialState,

    // ------------------------------------------------------------------------
    // Album Management
    // ------------------------------------------------------------------------

    initAlbum: (albumId: string) => {
      set((state) => {
        if (!state.albums.has(albumId)) {
          state.albums.set(albumId, createInitialAlbumState());
        }
      });
    },

    setActiveAlbum: (albumId: string | null) => {
      set((state) => {
        state.activeAlbumId = albumId;
      });
    },

    purgeAlbum: (albumId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) return;

        for (const item of album.items.values()) {
          if (item.localBlobUrl) {
            URL.revokeObjectURL(item.localBlobUrl);
          }
        }
        album.latePromoteIntents.clear();

        state.albums.delete(albumId);
        if (state.activeAlbumId === albumId) {
          state.activeAlbumId = null;
        }
      });
    },

    // ------------------------------------------------------------------------
    // Fetch Lifecycle
    // ------------------------------------------------------------------------

    startFetch: (albumId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (album) {
          album.fetchStatus = 'loading';
          album.fetchError = undefined;
        }
      });
    },

    completeFetch: (albumId, fetchedItems, cursor, hasMore = false) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) return;

        // Preserve non-stable items (pending, syncing, deleting)
        const preservedItems = new Map<string, PhotoItem>();
        for (const [id, item] of album.items) {
          if (item.status !== 'stable') {
            preservedItems.set(id, item);
          }
        }

        // Add fetched items as stable (don't overwrite non-stable)
        for (const fetchedItem of fetchedItems) {
          if (!preservedItems.has(fetchedItem.assetId)) {
            album.items.set(fetchedItem.assetId, {
              ...fetchedItem,
              albumId,
              status: 'stable',
            });
          }
        }

        // Re-add preserved non-stable items
        for (const [id, item] of preservedItems) {
          album.items.set(id, item);
        }

        album.fetchStatus = 'success';
        album.cursor = cursor;
        album.hasMore = hasMore;
        album.fetchError = undefined;
      });
    },

    failFetch: (albumId: string, error: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (album) {
          album.fetchStatus = 'error';
          album.fetchError = error;
        }
      });
    },

    // ------------------------------------------------------------------------
    // Pending Upload Lifecycle
    // ------------------------------------------------------------------------

    addPending: (albumId: string, assetId: string, localBlobUrl: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) {
          return;
        }

        // Safety net (option c): if the asset is already known stable
        // (e.g., addStableFromServer or a previous late-promote landed first),
        // do not regress it back to 'pending'. Revoke the unused blob URL.
        const existing = album.items.get(assetId);
        if (existing && existing.status === 'stable') {
          URL.revokeObjectURL(localBlobUrl);
          return;
        }

        // Late-promote intent path (option b): a sync-engine promotion
        // arrived BEFORE this addPending. Consume the intent and insert
        // directly as 'stable' instead of creating an orphan pending entry.
        const now = Date.now();
        const intent = album.latePromoteIntents.get(assetId);
        if (intent) {
          album.latePromoteIntents.delete(assetId);
          if (intent.expiresAt > now) {
            URL.revokeObjectURL(localBlobUrl);
            const newItem: PhotoItem = {
              assetId,
              albumId,
              status: 'stable',
            };
            if (intent.promotionData.encryptedMetadata !== undefined) {
              newItem.encryptedMetadata =
                intent.promotionData.encryptedMetadata;
            }
            if (intent.promotionData.thumbnailUrl !== undefined) {
              newItem.thumbnailUrl = intent.promotionData.thumbnailUrl;
            }
            if (intent.promotionData.createdAt !== undefined) {
              newItem.createdAt = intent.promotionData.createdAt;
            }
            album.items.set(assetId, newItem);
            return;
          }
          // Intent was stale — fall through to normal pending insert.
        }

        // Opportunistic cleanup of other stale intents.
        pruneStaleIntents(album.latePromoteIntents, now);

        album.items.set(assetId, {
          assetId,
          albumId,
          status: 'pending',
          localBlobUrl,
          uploadProgress: 0,
          uploadAction: 'waiting',
          createdAt: new Date(),
        });
      });
    },

    updateProgress: (
      albumId: string,
      assetId: string,
      progress: number,
      action?: UploadAction,
    ) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && (item.status === 'pending' || item.status === 'syncing')) {
          item.uploadProgress = Math.min(100, Math.max(0, progress));
          if (action) {
            item.uploadAction = action;
          }
        }
      });
    },

    transitionToSyncing: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && item.status === 'pending') {
          item.status = 'syncing';
        }
      });
    },

    promoteToStable: (
      albumId: string,
      assetId: string,
      metadata: Pick<
        PhotoItem,
        'encryptedMetadata' | 'thumbnailUrl' | 'createdAt'
      >,
    ) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) {
          return;
        }

        const item = album.items.get(assetId);
        if (item && (item.status === 'syncing' || item.status === 'pending')) {
          // Keep the same assetId - no ID change!
          item.status = 'stable';
          if (metadata.encryptedMetadata !== undefined) {
            item.encryptedMetadata = metadata.encryptedMetadata;
          }
          if (metadata.thumbnailUrl !== undefined) {
            item.thumbnailUrl = metadata.thumbnailUrl;
          }
          if (metadata.createdAt !== undefined) {
            item.createdAt = metadata.createdAt;
          }

          // Clean up pending-specific fields using delete
          delete item.localBlobUrl;
          delete item.uploadProgress;
          delete item.error;
          return;
        }

        // Existing stable item — nothing to do (sync may re-emit promotion).
        if (item && item.status === 'stable') return;

        // No item exists yet — race: promoteToStable arrived before
        // addPending. Buffer a late-promote intent so the upcoming
        // addPending inserts the photo directly as 'stable'.
        // Also handles the 'deleting' edge case: a delete in flight
        // should not be reverted by a stale promotion.
        if (!item) {
          const now = Date.now();
          pruneStaleIntents(album.latePromoteIntents, now);
          // Buffer a late-promote intent so the upcoming addPending
          // inserts the photo directly as 'stable'. Apply per-album
          // FIFO cap before inserting to bound memory on inactive
          // albums (v1.0.2 v102-latepromote-intent-ttl-sweep).
          const intents = album.latePromoteIntents;
          while (intents.size >= MAX_INTENTS_PER_ALBUM) {
            const oldest = intents.keys().next();
            if (oldest.done) break;
            intents.delete(oldest.value);
          }
          intents.set(assetId, {
            promotionData: metadata,
            expiresAt: now + LATE_PROMOTE_TTL_MS,
          });
        }
      });
    },

    markUploadFailed: (
      albumId: string,
      assetId: string,
      error: string,
      permanent = false,
    ) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && (item.status === 'pending' || item.status === 'syncing')) {
          item.error = error;
          if (permanent) {
            // Terminal state: pending-count / waitForSync observers
            // ignore this status so they unblock immediately.
            item.status = 'failed_permanent';
          }
        }
      });
    },

    resetForRetry: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && item.status === 'failed_permanent') {
          item.status = 'pending';
          item.uploadProgress = 0;
          item.uploadAction = 'waiting';
          delete item.error;
        }
      });
    },

    pruneAllLatePromoteIntents: () => {
      set((state) => {
        const now = Date.now();
        for (const album of state.albums.values()) {
          pruneStaleIntents(album.latePromoteIntents, now);
        }
      });
    },

    removePending: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) return;
        const item = album.items.get(assetId);
        if (
          item &&
          (item.status === 'pending' ||
            item.status === 'syncing' ||
            item.status === 'failed_permanent')
        ) {
          // Revoke blob URL to prevent memory leak
          if (item.localBlobUrl) {
            URL.revokeObjectURL(item.localBlobUrl);
          }
          album.items.delete(assetId);
        }
      });
    },

    // ------------------------------------------------------------------------
    // Delete Lifecycle
    // ------------------------------------------------------------------------

    markDeleting: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && item.status !== 'deleting') {
          item.previousStatus = item.status;
          item.status = 'deleting';
        }
      });
    },

    confirmDeleted: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (album) {
          album.items.delete(assetId);
        }
      });
    },

    revertDelete: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && item.status === 'deleting') {
          item.status = item.previousStatus ?? 'stable';
          delete item.previousStatus;
        }
      });
    },

    // ------------------------------------------------------------------------
    // Server Sync Lifecycle (from sync-coordinator)
    // ------------------------------------------------------------------------

    addStableFromServer: (
      albumId: string,
      assetId: string,
      thumbnailUrl?: string,
      createdAt?: Date,
    ) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) return;

        // Don't overwrite existing items
        if (album.items.has(assetId)) return;

        const newItem: PhotoItem = {
          assetId,
          albumId,
          status: 'stable',
        };

        if (thumbnailUrl !== undefined) {
          newItem.thumbnailUrl = thumbnailUrl;
        }
        if (createdAt !== undefined) {
          newItem.createdAt = createdAt;
        }

        album.items.set(assetId, newItem);
      });
    },

    updatePhotoFromServer: (
      albumId: string,
      assetId: string,
      thumbnailUrl?: string,
      createdAt?: Date,
    ) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);

        // Only update stable items
        if (item && item.status === 'stable') {
          if (thumbnailUrl !== undefined) {
            item.thumbnailUrl = thumbnailUrl;
          }
          if (createdAt !== undefined) {
            item.createdAt = createdAt;
          }
        }
      });
    },

    // ------------------------------------------------------------------------
    // Selectors
    // ------------------------------------------------------------------------

    getAlbumState: (albumId: string) => {
      return get().albums.get(albumId);
    },

    getPhoto: (albumId: string, assetId: string) => {
      return get().albums.get(albumId)?.items.get(assetId);
    },

    getPhotosByStatus: (albumId: string, status: PhotoStatus) => {
      const album = get().albums.get(albumId);
      if (!album) return [];

      const result: PhotoItem[] = [];
      for (const item of album.items.values()) {
        if (item.status === status) {
          result.push(item);
        }
      }
      return result;
    },

    getSortedPhotoList: (albumId: string) => {
      const album = get().albums.get(albumId);
      if (!album) return [];

      const items = Array.from(album.items.values());

      // Sort: pending first (newest first), then syncing, then stable/deleting by createdAt
      return items.sort((a, b) => {
        // Status priority: failed_permanent ≈ pending (top, user must act)
        const statusPriority: Record<PhotoStatus, number> = {
          failed_permanent: 0,
          pending: 0,
          syncing: 1,
          stable: 2,
          deleting: 2,
        };

        const priorityDiff =
          statusPriority[a.status] - statusPriority[b.status];
        if (priorityDiff !== 0) return priorityDiff;

        // Within same status, sort by createdAt (newest first)
        const aTime = a.createdAt?.getTime() ?? 0;
        const bTime = b.createdAt?.getTime() ?? 0;
        return bTime - aTime;
      });
    },
  })),
);

// ============================================================================
// Selector Hooks (for React components)
// ============================================================================

export const useActiveAlbumId = () =>
  usePhotoStore((state) => state.activeAlbumId);

export const useAlbumFetchStatus = (albumId: string): FetchStatus => {
  return usePhotoStore(
    (state) => state.albums.get(albumId)?.fetchStatus ?? 'idle',
  );
};

export const useAlbumHasMore = (albumId: string): boolean => {
  return usePhotoStore((state) => state.albums.get(albumId)?.hasMore ?? true);
};

export const usePhotoCount = (albumId: string): number => {
  return usePhotoStore((state) => state.albums.get(albumId)?.items.size ?? 0);
};

export const usePendingCount = (albumId: string): number => {
  return usePhotoStore((state) => {
    const album = state.albums.get(albumId);
    if (!album) return 0;
    let count = 0;
    for (const item of album.items.values()) {
      if (item.status === 'pending' || item.status === 'syncing') {
        count++;
      }
    }
    return count;
  });
};
