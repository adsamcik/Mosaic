import { useCallback, useEffect, useState } from 'react';
import { getDbClient } from '../lib/db-client';
import type { PhotoMeta } from '../workers/types';

/**
 * Hook to fetch photos for an album
 */
export function usePhotos(albumId: string) {
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
        const result = await db.getPhotos(albumId, 1000, 0);
        
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
  }, [albumId, refreshTrigger]);

  return { photos, isLoading, error, refetch };
}
