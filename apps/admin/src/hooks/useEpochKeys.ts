import { useCallback, useEffect, useState } from 'react';
import { fromBase64, getApi } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import { syncEngine } from '../lib/sync-engine';

/**
 * Hook to get epoch read key for decryption
 *
 * Returns the epoch read key for the given album and epoch.
 * Handles fetching and unwrapping the key if not already cached.
 */
export function useEpochKey(albumId: string, epochId: number) {
  const [epochReadKey, setEpochReadKey] = useState<Uint8Array | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadKey = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Check cache first
      let key = syncEngine.getEpochKey(albumId, epochId);
      if (key) {
        setEpochReadKey(key);
        return;
      }

      // Fetch epoch keys from server
      const api = getApi();
      const crypto = await getCryptoClient();

      const epochKeys = await api.getEpochKeys(albumId);
      const epochKeyRecord = epochKeys.find((ek) => ek.epochId === epochId);

      if (!epochKeyRecord) {
        throw new Error(`No epoch key found for epoch ${epochId}`);
      }

      // Get the user's identity public key for unwrapping
      const identityPubkey = await crypto.getIdentityPublicKey();
      if (!identityPubkey) {
        throw new Error('Identity key not available');
      }

      // Unwrap the epoch key bundle
      const bundle = fromBase64(epochKeyRecord.encryptedKeyBundle);
      const sharerPubkey = fromBase64(epochKeyRecord.sharerPubkey);

      const unwrapped = await crypto.openEpochKeyBundle(
        bundle,
        sharerPubkey,
        albumId,
        0 // minEpochId - accept any epoch for now
      );

      key = unwrapped.epochSeed;

      // Cache the key
      syncEngine.setEpochKey(albumId, epochId, key);

      setEpochReadKey(key);
    } catch (err) {
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
 * Returns a map of epochId -> readKey
 */
export function useAlbumEpochKeys(albumId: string) {
  const [epochKeys, setEpochKeys] = useState<Map<number, Uint8Array>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const api = getApi();
      const crypto = await getCryptoClient();

      const serverKeys = await api.getEpochKeys(albumId);

      if (serverKeys.length === 0) {
        setEpochKeys(new Map());
        return;
      }

      // Get identity key
      const identityPubkey = await crypto.getIdentityPublicKey();
      if (!identityPubkey) {
        throw new Error('Identity key not available');
      }

      const keysMap = new Map<number, Uint8Array>();

      // Unwrap each epoch key
      for (const ek of serverKeys) {
        // Check cache first
        let key = syncEngine.getEpochKey(albumId, ek.epochId);
        if (key) {
          keysMap.set(ek.epochId, key);
          continue;
        }

        try {
          const bundle = fromBase64(ek.encryptedKeyBundle);
          const sharerPubkey = fromBase64(ek.sharerPubkey);

          const unwrapped = await crypto.openEpochKeyBundle(
            bundle,
            sharerPubkey,
            albumId,
            0
          );

          key = unwrapped.epochSeed;
          keysMap.set(ek.epochId, key);
          syncEngine.setEpochKey(albumId, ek.epochId, key);
        } catch (unwrapError) {
          console.warn(`Failed to unwrap epoch key ${ek.epochId}:`, unwrapError);
        }
      }

      setEpochKeys(keysMap);
    } catch (err) {
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
