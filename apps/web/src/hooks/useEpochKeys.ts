import { useCallback, useEffect, useState } from 'react';
import { getOrFetchEpochKey } from '../lib/epoch-key-service';
import { createLogger } from '../lib/logger';
import type { EpochHandleId } from '../workers/types';

const log = createLogger('useEpochKeys');

/**
 * Hook to get epoch handle for decryption
 *
 * Returns the epoch handle id for the given album and epoch.
 * Handles fetching and unwrapping the key if not already cached.
 *
 * Uses epoch-key-service for proper key management, which stores
 * complete bundles including signKeypair.
 */
export function useEpochKey(albumId: string, epochId: number) {
  const [epochReadKey, setEpochReadKey] = useState<EpochHandleId | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadKey = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Use the centralized epoch-key-service which properly caches complete bundles
      const bundle = await getOrFetchEpochKey(albumId, epochId);
      setEpochReadKey(bundle.epochHandleId as EpochHandleId);
    } catch (err) {
      log.error(
        `Failed to get epoch key ${epochId} for album ${albumId}:`,
        err,
      );
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [albumId, epochId]);

  useEffect(() => {
    void loadKey();
  }, [loadKey]);

  return { epochReadKey, isLoading, error, reload: loadKey };
}

/**
 * Hook to get all epoch keys for an album
 * Returns a map of epochId -> epoch handle id
 *
 * Uses fetchAndUnwrapEpochKeys from epoch-key-service which stores
 * complete bundles including signKeypair.
 */
export function useAlbumEpochKeys(albumId: string) {
  const [epochKeys, setEpochKeys] = useState<Map<number, EpochHandleId>>(
    new Map(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Use the centralized epoch-key-service which properly caches complete bundles
      const { fetchAndUnwrapEpochKeys } =
        await import('../lib/epoch-key-service');
      const bundles = await fetchAndUnwrapEpochKeys(albumId);

      const keysMap = new Map<number, EpochHandleId>();
      for (const bundle of bundles) {
        keysMap.set(bundle.epochId, bundle.epochHandleId as EpochHandleId);
      }

      setEpochKeys(keysMap);
    } catch (err) {
      log.error(`Failed to load epoch keys for album ${albumId}:`, err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [albumId]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  return { epochKeys, isLoading, error, reload: loadKeys };
}
