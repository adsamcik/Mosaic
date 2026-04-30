import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, getApi } from '../lib/api';
import { getOrFetchEpochKey } from '../lib/epoch-key-service';
import { createLogger } from '../lib/logger';
import { purgeLocalAlbum } from '../lib/local-purge';
import {
  getSettings,
  subscribeToSettings,
  type UserSettings,
} from '../lib/settings-service';
import { syncEngine } from '../lib/sync-engine';

const log = createLogger('SyncContext');

/** Default interval for auto-sync in milliseconds (60 seconds) */
const AUTO_SYNC_INTERVAL_MS = 60_000;

/** SyncContext value */
interface SyncContextValue {
  /** Whether auto-sync is currently enabled */
  autoSyncEnabled: boolean;
  /** Set of album IDs currently being synced */
  syncingAlbums: Set<string>;
  /** Last sync time per album */
  lastSyncTime: Map<string, Date>;
  /** Manually trigger sync for an album */
  triggerSync: (albumId: string) => Promise<void>;
  /** Register an album for auto-sync (call when viewing an album) */
  registerAlbum: (albumId: string) => void;
  /** Unregister an album from auto-sync (call when leaving an album) */
  unregisterAlbum: (albumId: string) => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

interface SyncProviderProps {
  children: ReactNode;
}

/**
 * Provider component for background auto-sync functionality.
 * When autoSync setting is enabled, periodically syncs registered albums.
 */
export function SyncProvider({ children }: SyncProviderProps) {
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(
    () => getSettings().autoSync,
  );
  const [syncingAlbums, setSyncingAlbums] = useState<Set<string>>(new Set());
  const [lastSyncTime, setLastSyncTime] = useState<Map<string, Date>>(
    new Map(),
  );

  // Track registered albums for auto-sync
  const registeredAlbums = useRef<Set<string>>(new Set());
  const intervalRef = useRef<number | null>(null);

  // Synchronous lock to prevent race conditions in async sync operations.
  // Using a ref instead of state because:
  // 1. State updates are asynchronous - between check and update, another call can slip through
  // 2. Refs are synchronous - the lock is immediately visible to all code paths
  // 3. We still maintain syncingAlbums state for UI reactivity (showing spinners, etc.)
  const syncLockRef = useRef<Set<string>>(new Set());

  // Subscribe to settings changes
  useEffect(() => {
    return subscribeToSettings((settings: UserSettings) => {
      setAutoSyncEnabled(settings.autoSync);
    });
  }, []);

  // Sync a single album
  const syncAlbum = useCallback(async (albumId: string): Promise<void> => {
    // Check the synchronous ref lock to prevent race conditions.
    // This check is atomic - no async gaps between check and set.
    if (syncLockRef.current.has(albumId)) {
      log.debug(`Album ${albumId} already syncing, skipping`);
      return;
    }

    // Acquire lock synchronously BEFORE any async work
    syncLockRef.current.add(albumId);

    try {
      // Update state for UI reactivity (spinners, disabled buttons, etc.)
      setSyncingAlbums((prev) => new Set([...prev, albumId]));

      // Get the current epoch key for this album
      const api = getApi();
      const album = await api.getAlbum(albumId);

      if (!album) {
        log.warn(`Album ${albumId} not found`);
        return;
      }

      // Get the most recent epoch key
      const epochKey = await getOrFetchEpochKey(albumId, album.currentEpochId);

      // Perform sync
      await syncEngine.sync(albumId, epochKey.epochSeed);

      setLastSyncTime((prev) => new Map([...prev, [albumId, new Date()]]));
      log.info(`Auto-sync complete for album ${albumId}`);
    } catch (err) {
      // Per SPEC-TimedExpiration: clients MUST treat 410 Gone the same as 404
      // for local purge. 410 means the album existed but is now inaccessible
      // due to expiry; 404 means it has been hard-deleted. Both routes purge
      // local state, but with distinct reasons so blocker telemetry can
      // distinguish expired-album purges from missing-album purges.
      if (
        err instanceof ApiError &&
        (err.status === 404 || err.status === 410)
      ) {
        const reason: 'album-404' | 'album-410' =
          err.status === 410 ? 'album-410' : 'album-404';
        log.warn(
          `Album ${albumId} is ${
            err.status === 410 ? 'expired' : 'gone'
          } (${err.status}), cleaning up`,
        );
        registeredAlbums.current.delete(albumId);

        // Clear local data for the deleted or expired album.
        try {
          const result = await purgeLocalAlbum({ albumId, reason });
          if (result.blockers.length > 0) {
            log.warn('Album local purge completed with blockers', {
              albumId,
              blockers: result.blockers,
            });
          }
        } catch (cleanupErr) {
          log.error(`Failed to clean up local data for album ${albumId}:`, cleanupErr);
        }
      } else {
        log.error(`Auto-sync failed for album ${albumId}:`, err);
      }
    } finally {
      // Release lock synchronously
      syncLockRef.current.delete(albumId);
      // Update UI state
      setSyncingAlbums((prev) => {
        const next = new Set(prev);
        next.delete(albumId);
        return next;
      });
    }
  }, []);

  // Trigger sync for all registered albums
  const syncAllRegistered = useCallback(async () => {
    const albums = Array.from(registeredAlbums.current);
    if (albums.length === 0) {
      return;
    }

    log.debug(`Auto-sync tick: syncing ${albums.length} album(s)`);

    // Sync albums sequentially to avoid overwhelming the server
    for (const albumId of albums) {
      await syncAlbum(albumId);
    }
  }, [syncAlbum]);

  // Set up auto-sync interval
  useEffect(() => {
    // Clear existing interval
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Start new interval if auto-sync is enabled
    if (autoSyncEnabled) {
      log.info('Auto-sync enabled, starting background sync');
      intervalRef.current = window.setInterval(() => {
        void syncAllRegistered();
      }, AUTO_SYNC_INTERVAL_MS);
    } else {
      log.info('Auto-sync disabled');
    }

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoSyncEnabled, syncAllRegistered]);

  // Register an album for auto-sync
  const registerAlbum = useCallback((albumId: string) => {
    registeredAlbums.current.add(albumId);
    log.debug(`Registered album ${albumId} for auto-sync`);
  }, []);

  // Unregister an album from auto-sync
  const unregisterAlbum = useCallback((albumId: string) => {
    registeredAlbums.current.delete(albumId);
    log.debug(`Unregistered album ${albumId} from auto-sync`);
  }, []);

  // Manually trigger sync for an album
  const triggerSync = useCallback(
    async (albumId: string): Promise<void> => {
      await syncAlbum(albumId);
    },
    [syncAlbum],
  );

  // Memoize context value to prevent unnecessary re-renders of consumers
  const contextValue = useMemo<SyncContextValue>(
    () => ({
      autoSyncEnabled,
      syncingAlbums,
      lastSyncTime,
      triggerSync,
      registerAlbum,
      unregisterAlbum,
    }),
    [autoSyncEnabled, syncingAlbums, lastSyncTime, triggerSync, registerAlbum, unregisterAlbum],
  );

  return (
    <SyncContext.Provider value={contextValue}>
      {children}
    </SyncContext.Provider>
  );
}

/**
 * Hook to access sync context.
 * Must be used within a SyncProvider.
 */
export function useSyncContext(): SyncContextValue {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSyncContext must be used within a SyncProvider');
  }
  return context;
}

/**
 * Hook for components that want to opt into auto-sync for a specific album.
 * Call this in a component viewing an album to register it for background sync.
 */
export function useAutoSync(albumId: string): void {
  const { registerAlbum, unregisterAlbum } = useSyncContext();

  useEffect(() => {
    registerAlbum(albumId);
    return () => unregisterAlbum(albumId);
  }, [albumId, registerAlbum, unregisterAlbum]);
}
