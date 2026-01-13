import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { getDbClient } from '../lib/db-client';
import { createLogger } from '../lib/logger';
import { syncEngine, type SyncEventDetail } from '../lib/sync-engine';
import {
    type AlbumPhotoState,
    type PhotoItem,
    type PhotoStore,
    usePhotoStore,
} from '../stores/photo-store';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('usePhotoList');

/**
 * Result returned by usePhotoList hook
 */
export interface UsePhotoListResult {
  /** Array of photos for the album, sorted and optionally filtered */
  photos: PhotoMeta[];
  /** True during initial load */
  isLoading: boolean;
  /** True during refetch (has existing data) */
  isRefreshing: boolean;
  /** Error if fetch failed (compatible with old usePhotos interface) */
  error: Error | null;
  /** Trigger a refetch from database */
  refetch: () => Promise<void>;
}

/**
 * Options for usePhotoList hook
 */
export interface UsePhotoListOptions {
  /** Album ID to load photos for */
  albumId: string;
  /** Optional search query for filtering photos (uses FTS5) */
  searchQuery?: string;
}

/**
 * Selector for pending photos from the store
 */
function createPendingSelector(albumId: string) {
  return (state: { albums: Map<string, AlbumPhotoState> }) => {
    const album = state.albums.get(albumId);
    if (!album) return [] as PhotoItem[];
    
    // Return only pending/syncing items
    return Array.from(album.items.values()).filter(
      (item) => item.status === 'pending' || item.status === 'syncing'
    );
  };
}

/**
 * Convert a pending PhotoItem to a PhotoMeta-like object for display
 * This allows pending uploads to appear in the photo grid with thumbnails
 */
function pendingToPhotoMeta(item: PhotoItem): PhotoMeta {
  const base: PhotoMeta = {
    id: item.assetId, // Use assetId as id for pending items
    assetId: item.assetId,
    albumId: item.albumId,
    filename: 'Uploading...',
    mimeType: 'image/jpeg',
    width: 0,
    height: 0,
    tags: [],
    createdAt: item.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shardIds: [],
    epochId: 0,
    // Pending upload state
    isPending: true,
    uploadProgress: item.uploadProgress ?? 0,
    uploadAction: item.uploadAction ?? 'waiting',
    isSyncing: item.status === 'syncing',
  };
  
  // Only add error if we have a value (exactOptionalPropertyTypes)
  if (item.error) {
    base.uploadError = item.error;
  }
  
  // Only add thumbnail if we have a value (exactOptionalPropertyTypes)
  // localBlobUrl is a blob: URL, which JustifiedPhotoThumbnail now handles
  const thumbnailValue = item.localBlobUrl ?? item.thumbnailUrl;
  if (thumbnailValue) {
    base.thumbnail = thumbnailValue;
  }
  
  return base;
}

/**
 * Hook that bridges PhotoStore (Zustand) to components.
 * 
 * Provides the same interface as usePhotos but uses the centralized PhotoStore
 * for pending photo tracking to prevent blinking issues.
 * 
 * Features:
 * - Fetches photos from local database
 * - Subscribes to pending uploads from PhotoStore
 * - Merges pending uploads with stable photos (pending appear first)
 * - Supports search query filtering via FTS5
 * - Memoizes results to prevent unnecessary re-renders
 * 
 * @param options - Album ID and optional search query
 * @returns Photos array, loading state, error, and refetch function
 */
export function usePhotoList(options: UsePhotoListOptions): UsePhotoListResult;
export function usePhotoList(albumId: string, searchQuery?: string): UsePhotoListResult;
export function usePhotoList(
  albumIdOrOptions: string | UsePhotoListOptions,
  searchQueryArg?: string
): UsePhotoListResult {
  // Normalize arguments
  const { albumId, searchQuery } = typeof albumIdOrOptions === 'string'
    ? { albumId: albumIdOrOptions, searchQuery: searchQueryArg }
    : albumIdOrOptions;

  // Local state for DB photos (full PhotoMeta objects)
  const [dbPhotos, setDbPhotos] = useState<PhotoMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track if this is the initial mount to prevent duplicate fetches
  const initialFetchDone = useRef(false);
  const currentAlbumId = useRef(albumId);

  // Initialize album in store (for pending photo tracking)
  const initAlbum = usePhotoStore((state: PhotoStore) => state.initAlbum);

  // Subscribe to pending photos from store
  const pendingSelector = useMemo(() => createPendingSelector(albumId), [albumId]);
  const pendingItems = usePhotoStore(useShallow(pendingSelector));

  /**
   * Fetch photos from database
   */
  const fetchFromDb = useCallback(async () => {
    log.debug(`Fetching photos for album ${albumId}`, { searchQuery });
    
    const hadPhotos = dbPhotos.length > 0;
    
    try {
      if (hadPhotos) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);
      
      const db = await getDbClient();
      
      let result: PhotoMeta[];
      if (searchQuery && searchQuery.trim().length > 0) {
        // Use FTS5 search
        result = await db.searchPhotos(albumId, searchQuery.trim());
      } else {
        // Regular fetch - get all photos
        result = await db.getPhotos(albumId, 10000, 0);
      }
      
      setDbPhotos(result);
      log.debug(`Loaded ${result.length} photos for album ${albumId}`);
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      log.error(`Failed to fetch photos for album ${albumId}:`, err);
      setError(errorObj);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [albumId, searchQuery, dbPhotos.length]);

  /**
   * Refetch photos (can be called manually)
   */
  const refetch = useCallback(async () => {
    await fetchFromDb();
  }, [fetchFromDb]);

  // Initialize album and fetch on mount or when albumId changes
  useEffect(() => {
    // Reset fetch tracking when album changes
    if (currentAlbumId.current !== albumId) {
      initialFetchDone.current = false;
      currentAlbumId.current = albumId;
      setDbPhotos([]); // Clear photos when switching albums
    }

    // Initialize album in store for pending tracking
    initAlbum(albumId);

    // Only fetch if we haven't done initial fetch for this album
    if (!initialFetchDone.current) {
      initialFetchDone.current = true;
      void fetchFromDb();
    }
  }, [albumId, initAlbum, fetchFromDb]);

  // Refetch when search query changes
  useEffect(() => {
    // Skip the initial mount (handled by the albumId effect)
    if (!initialFetchDone.current) return;
    
    void fetchFromDb();
  }, [searchQuery, fetchFromDb]);

  // Listen for sync-complete events to refresh photos
  useEffect(() => {
    const handleSyncComplete = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      // Only refetch if this sync is for our album
      if (detail.albumId === albumId) {
        log.debug(`Sync complete for album ${albumId}, refreshing photos`);
        void fetchFromDb();
      }
    };

    syncEngine.addEventListener('sync-complete', handleSyncComplete);
    return () => {
      syncEngine.removeEventListener('sync-complete', handleSyncComplete);
    };
  }, [albumId, fetchFromDb]);

  // Merge pending photos with DB photos
  // Pending photos appear first, sorted by createdAt descending
  const mergedPhotos = useMemo(() => {
    // Convert pending items to PhotoMeta format
    const pendingPhotos = pendingItems.map(pendingToPhotoMeta);
    
    // Sort pending by createdAt (newest first)
    pendingPhotos.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    // Filter out any DB photos that are being re-uploaded (by assetId)
    const pendingAssetIds = new Set(pendingItems.map(p => p.assetId));
    const filteredDbPhotos = dbPhotos.filter(p => !pendingAssetIds.has(p.assetId));
    
    // Return pending first, then stable photos
    return [...pendingPhotos, ...filteredDbPhotos];
  }, [pendingItems, dbPhotos]);

  return {
    photos: mergedPhotos,
    isLoading,
    isRefreshing,
    error,
    refetch,
  };
}
