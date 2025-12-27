/**
 * useAlbumCover Hook
 *
 * Fetches and decrypts the cover photo thumbnail for an album.
 * Manages loading state and cleans up blob URLs on unmount.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getAlbumCover,
  getCachedCover,
  type AlbumCover,
} from '../lib/album-cover-service';
import { getCurrentOrFetchEpochKey } from '../lib/epoch-key-service';

/**
 * Album cover loading state
 */
export interface UseAlbumCoverResult {
  /** Blob URL for the cover image, null if not loaded or no photos */
  coverUrl: string | null;
  /** Whether the cover is currently loading */
  isLoading: boolean;
  /** Error if loading failed */
  error: Error | null;
  /** Photo ID used as cover */
  photoId: string | null;
  /** Reload the cover (force refresh) */
  reload: () => void;
}

/**
 * Hook to fetch and decrypt album cover thumbnail.
 *
 * @param albumId - Album ID to get cover for
 * @param enabled - Whether to fetch the cover (default: true)
 * @returns Cover loading state and result
 *
 * @example
 * ```tsx
 * function AlbumCard({ album }) {
 *   const { coverUrl, isLoading, error } = useAlbumCover(album.id);
 *
 *   return (
 *     <div className="album-cover">
 *       {isLoading ? (
 *         <LoadingSpinner />
 *       ) : coverUrl ? (
 *         <img src={coverUrl} alt={album.name} />
 *       ) : (
 *         <FolderIcon />
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useAlbumCover(
  albumId: string,
  enabled = true
): UseAlbumCoverResult {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  const reload = useCallback(() => {
    setReloadCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !albumId) {
      setCoverUrl(null);
      setPhotoId(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadCover() {
      // Check cache first
      const cached = getCachedCover(albumId);
      if (cached) {
        setCoverUrl(cached.blobUrl);
        setPhotoId(cached.photoId);
        setIsLoading(false);
        setError(null);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // Get epoch key for this album
        const epochKey = await getCurrentOrFetchEpochKey(albumId);

        if (cancelled) return;

        // Get album cover
        const cover = await getAlbumCover(albumId, epochKey.readKey);

        if (cancelled) return;

        if (cover) {
          setCoverUrl(cover.blobUrl);
          setPhotoId(cover.photoId);
        } else {
          // Album has no photos
          setCoverUrl(null);
          setPhotoId(null);
        }
      } catch (err) {
        if (cancelled) return;

        console.error(`Failed to load cover for album ${albumId}:`, err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setCoverUrl(null);
        setPhotoId(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadCover();

    return () => {
      cancelled = true;
    };
  }, [albumId, enabled, reloadCounter]);

  // Note: We don't release the cover on unmount because it's cached
  // and may be needed again. The cache handles cleanup.

  return {
    coverUrl,
    isLoading,
    error,
    photoId,
    reload,
  };
}

export type { AlbumCover };
