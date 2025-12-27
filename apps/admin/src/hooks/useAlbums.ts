import { useState, useEffect, useCallback } from 'react';
import { getApi } from '../lib/api';
import type { Album } from '../components/Albums/AlbumCard';

/**
 * Hook to fetch albums from the API
 */
export function useAlbums() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadAlbums = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const api = getApi();
      const apiAlbums = await api.listAlbums();

      // Transform API albums to frontend format
      // Note: Album names are encrypted and stored in album metadata
      // For now, use a placeholder name based on ID
      const transformedAlbums: Album[] = apiAlbums.map((album) => ({
        id: album.id,
        // Placeholder name until we have encrypted album metadata
        name: `Album ${album.id.slice(0, 8)}`,
        // Photo count is not returned from API - would need to sync first
        // This could be tracked in local DB after sync
        photoCount: 0,
        createdAt: album.createdAt,
      }));

      setAlbums(transformedAlbums);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAlbums();
  }, [loadAlbums]);

  return { albums, isLoading, error, refetch: loadAlbums };
}
