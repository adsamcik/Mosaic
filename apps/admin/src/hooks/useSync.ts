import { useState, useEffect, useCallback } from 'react';
import { syncEngine } from '../lib/sync-engine';
import type { SyncEventDetail } from '../lib/sync-engine';
import { createLogger } from '../lib/logger';

const log = createLogger('useSync');

/** Sync status states */
export type SyncStatus = 'idle' | 'syncing' | 'error';

/** Sync progress information */
export interface SyncProgress {
  albumId: string | null;
  count: number;
}

/** useSync hook return type */
export interface UseSyncResult {
  /** Current sync status */
  status: SyncStatus;
  /** Sync progress information */
  progress: SyncProgress;
  /** Last sync error, if any */
  error: Error | null;
  /** Sync a specific album */
  syncAlbum: (albumId: string, readKey: Uint8Array) => Promise<void>;
  /** Sync all albums (requires album list and read keys) */
  syncAll: (
    albums: Array<{ id: string; readKey: Uint8Array }>
  ) => Promise<void>;
}

/**
 * React hook for SyncEngine integration
 * Provides sync status, progress tracking, and sync functions
 */
export function useSync(): UseSyncResult {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [progress, setProgress] = useState<SyncProgress>({
    albumId: null,
    count: 0,
  });
  const [error, setError] = useState<Error | null>(null);

  // Set up event listeners on mount
  useEffect(() => {
    const handleStart = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      setStatus('syncing');
      setError(null);
      setProgress({ albumId: detail.albumId, count: 0 });
    };

    const handleProgress = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      setProgress((prev) => ({
        albumId: detail.albumId,
        count: prev.count + (detail.count ?? 0),
      }));
    };

    const handleComplete = (_event: Event) => {
      setStatus('idle');
    };

    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      setStatus('error');
      setError(detail.error ?? new Error('Unknown sync error'));
    };

    // Add event listeners
    syncEngine.addEventListener('sync-start', handleStart);
    syncEngine.addEventListener('sync-progress', handleProgress);
    syncEngine.addEventListener('sync-complete', handleComplete);
    syncEngine.addEventListener('sync-error', handleError);

    // Cleanup on unmount
    return () => {
      syncEngine.removeEventListener('sync-start', handleStart);
      syncEngine.removeEventListener('sync-progress', handleProgress);
      syncEngine.removeEventListener('sync-complete', handleComplete);
      syncEngine.removeEventListener('sync-error', handleError);
    };
  }, []);

  /**
   * Sync a specific album
   */
  const syncAlbum = useCallback(
    async (albumId: string, readKey: Uint8Array): Promise<void> => {
      try {
        await syncEngine.sync(albumId, readKey);
      } catch (err) {
        // Error is already set via event listener
        log.error('Sync failed:', err);
      }
    },
    []
  );

  /**
   * Sync all albums sequentially
   */
  const syncAll = useCallback(
    async (
      albums: Array<{ id: string; readKey: Uint8Array }>
    ): Promise<void> => {
      for (const album of albums) {
        try {
          await syncEngine.sync(album.id, album.readKey);
        } catch (err) {
          // Continue with next album on error
          log.error(`Sync failed for album ${album.id}:`, err);
        }
      }
    },
    []
  );

  return {
    status,
    progress,
    error,
    syncAlbum,
    syncAll,
  };
}
