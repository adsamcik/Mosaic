import { useCallback, useEffect, useState } from 'react';
import { getDbClient } from '../lib/db-client';
import type { PhotoMeta } from '../workers/types';

/**
 * Hook to fetch photos for an album
 * Supports optional search query using FTS5 full-text search
 */
export function usePhotos(albumId: string, searchQuery?: string) {
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Function to trigger a refresh
  const refetch = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPhotos() {
      try {
        setIsLoading(true);
        setError(null);
        
        const db = await getDbClient();
        
        let result: PhotoMeta[];
        if (searchQuery && searchQuery.trim().length > 0) {
          // Use FTS5 search
          result = await db.searchPhotos(albumId, searchQuery.trim());
        } else {
          // Regular fetch
          result = await db.getPhotos(albumId, 1000, 0);
        }
        
        if (!cancelled) {
          setPhotos(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadPhotos();

    return () => {
      cancelled = true;
    };
  }, [albumId, searchQuery, refreshTrigger]);

  return { photos, isLoading, error, refetch };
}
