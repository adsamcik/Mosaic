import { create } from 'zustand';
import { mutative } from 'zustand-mutative';

// ============================================================================
// Types
// ============================================================================

export type PhotoStatus = 'stable' | 'pending' | 'syncing' | 'deleting';

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

export interface AlbumPhotoState {
  items: Map<string, PhotoItem>;
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
  markUploadFailed: (albumId: string, assetId: string, error: string) => void;
  removePending: (albumId: string, assetId: string) => void;

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
  fetchStatus: 'idle',
  hasMore: true,
  cursor: undefined,
  fetchError: undefined,
});

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
        if (!album) return;

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
        const item = album?.items.get(assetId);
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
        }
      });
    },

    markUploadFailed: (albumId: string, assetId: string, error: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        const item = album?.items.get(assetId);
        if (item && (item.status === 'pending' || item.status === 'syncing')) {
          item.error = error;
        }
      });
    },

    removePending: (albumId: string, assetId: string) => {
      set((state) => {
        const album = state.albums.get(albumId);
        if (!album) return;
        const item = album.items.get(assetId);
        if (item && (item.status === 'pending' || item.status === 'syncing')) {
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
        // Status priority: pending > syncing > stable/deleting
        const statusPriority: Record<PhotoStatus, number> = {
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
