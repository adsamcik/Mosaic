import { useState, useEffect } from 'react';
import type { Album } from '../components/Albums/AlbumCard';

// Mock albums for development
const MOCK_ALBUMS: Album[] = [
  { id: '1', name: 'Vacation 2024', photoCount: 45, createdAt: '2024-06-15T10:00:00Z' },
  { id: '2', name: 'Family', photoCount: 128, createdAt: '2024-01-01T00:00:00Z' },
  { id: '3', name: 'Work Events', photoCount: 23, createdAt: '2024-03-20T14:30:00Z' },
];

/**
 * Hook to fetch albums
 */
export function useAlbums() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAlbums() {
      try {
        setIsLoading(true);
        setError(null);

        // TODO: Fetch albums from API
        // For now, use mock data with simulated delay
        await new Promise((r) => setTimeout(r, 500));

        if (!cancelled) {
          setAlbums(MOCK_ALBUMS);
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

    void loadAlbums();

    return () => {
      cancelled = true;
    };
  }, []);

  return { albums, isLoading, error };
}
