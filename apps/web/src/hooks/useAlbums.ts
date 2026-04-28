import { memzero } from '@mosaic/crypto';
import { useCallback, useEffect, useState } from 'react';
import type { Album } from '../components/Albums/AlbumCard';
import {
  getDecryptedAlbumName,
  getStoredEncryptedName,
  setStoredEncryptedName,
} from '../lib/album-metadata-service';
import { getApi, paginateAll, toBase64 } from '../lib/api';
import type { Album as ApiAlbum } from '../lib/api-types';
import { getCryptoClient } from '../lib/crypto-client';
import { getDbClient } from '../lib/db-client';
import { ensureEpochKeysLoaded } from '../lib/epoch-key-service';
import { clearAlbumKeys, getCurrentEpochKey, setEpochKey } from '../lib/epoch-key-store';
import { createLogger } from '../lib/logger';
import { syncEngine } from '../lib/sync-engine';

const log = createLogger('useAlbums');

/**
 * Encrypt album name using XChaCha20-Poly1305 with the epoch seed.
 * Uses the envelope format via crypto worker's encryptShard.
 *
 * @param name - Album name to encrypt
 * @param epochSeed - Epoch seed key (32 bytes)
 * @returns Base64-encoded encrypted name
 */
async function encryptAlbumName(
  name: string,
  epochSeed: Uint8Array,
): Promise<string> {
  const crypto = await getCryptoClient();
  const nameBytes = new TextEncoder().encode(name);

  // Use epoch 0, shard 0 for album metadata (reserved)
  const encrypted = await crypto.encryptShard(nameBytes, epochSeed, 0, 0);

  return toBase64(encrypted.ciphertext);
}

/**
 * Load photo counts from local SQLite database for all albums.
 * Returns a map of albumId -> count.
 */
async function fetchPhotoCountsFromDb(
  albumIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const db = await getDbClient();

    // Fetch photo counts for all albums in parallel
    const results = await Promise.all(
      albumIds.map(async (albumId) => ({
        albumId,
        count: await db.getPhotoCount(albumId),
      })),
    );

    for (const { albumId, count } of results) {
      counts.set(albumId, count);
    }
  } catch (err) {
    log.error('Failed to load photo counts from database:', err);
    // Non-fatal - return empty map, counts will stay at 0
  }
  return counts;
}

/**
 * Hook to manage albums (list, create)
 */
export function useAlbums() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadAlbums = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const api = getApi();
      const apiAlbums = await paginateAll((skip, take) =>
        api.listAlbums(skip, take),
      );

      // Transform API albums to frontend format with placeholder names
      // Names will be decrypted asynchronously after initial load
      const transformedAlbums: Album[] = apiAlbums.map((album) => ({
        id: album.id,
        // Placeholder name until decryption completes
        name: `Album ${album.id.slice(0, 8)}`,
        // Photo count loaded from local SQLite database
        photoCount: 0,
        createdAt: album.createdAt,
        isDecrypting: true, // Mark as decrypting initially
        decryptionFailed: false,
        // Preserve encrypted name from server for decryption
        encryptedName: album.encryptedName ?? null,
      }));

      // Set initial state with placeholder names
      setAlbums(transformedAlbums);
      setIsLoading(false);

      // Load photo counts from local database (non-blocking)
      const albumIds = transformedAlbums.map((a) => a.id);
      const photoCounts = await fetchPhotoCountsFromDb(albumIds);

      // Update albums with photo counts
      setAlbums((prev) =>
        prev.map((album) => ({
          ...album,
          photoCount: photoCounts.get(album.id) ?? album.photoCount,
        })),
      );

      // Decrypt album names asynchronously
      await decryptAlbumNames(transformedAlbums);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Decrypt album names using epoch keys.
   * Updates album state as names are decrypted.
   */
  const decryptAlbumNames = useCallback(async (albumsToDecrypt: Album[]) => {
    // Process each album's name decryption
    const decryptionPromises = albumsToDecrypt.map(async (album) => {
      try {
        // Try to get encrypted name from server response first,
        // then fallback to localStorage (for backwards compatibility)
        const encryptedName =
          album.encryptedName ?? getStoredEncryptedName(album.id);

        if (!encryptedName) {
          // No encrypted name available - keep placeholder
          // This happens for albums created by other users or before encryption was added
          setAlbums((prev) =>
            prev.map((a) =>
              a.id === album.id ? { ...a, isDecrypting: false } : a,
            ),
          );
          return;
        }

        // Load epoch keys for this album
        const keysLoaded = await ensureEpochKeysLoaded(album.id);
        if (!keysLoaded) {
          // Can't decrypt without keys
          log.error(`Album ${album.id}: Failed to load epoch keys`);
          setAlbums((prev) =>
            prev.map((a) =>
              a.id === album.id
                ? { ...a, isDecrypting: false, decryptionFailed: true }
                : a,
            ),
          );
          return;
        }

        // Get the current epoch key
        const epochKey = getCurrentEpochKey(album.id);
        if (!epochKey) {
          // No epoch key available
          log.error(`Album ${album.id}: No epoch key in cache after loading`);
          setAlbums((prev) =>
            prev.map((a) =>
              a.id === album.id
                ? { ...a, isDecrypting: false, decryptionFailed: true }
                : a,
            ),
          );
          return;
        }

        // Decrypt the album name
        const decryptedName = await getDecryptedAlbumName(
          album.id,
          encryptedName,
          epochKey.epochSeed,
        );

        // Update state with decrypted name
        setAlbums((prev) =>
          prev.map((a) =>
            a.id === album.id
              ? {
                  ...a,
                  name: decryptedName,
                  decryptedName,
                  isDecrypting: false,
                  decryptionFailed: false,
                }
              : a,
          ),
        );
      } catch (err) {
        log.error(`Failed to decrypt album name for ${album.id}:`, err);
        // Mark as failed but keep placeholder name
        setAlbums((prev) =>
          prev.map((a) =>
            a.id === album.id
              ? { ...a, isDecrypting: false, decryptionFailed: true }
              : a,
          ),
        );
      }
    });

    // Wait for all decryption attempts to complete
    await Promise.all(decryptionPromises);
  }, []);

  /**
   * Update photo count for a single album.
   * Called when sync completes for an album.
   */
  const updatePhotoCount = useCallback(async (albumId: string) => {
    try {
      const db = await getDbClient();
      const count = await db.getPhotoCount(albumId);

      setAlbums((prev) =>
        prev.map((album) =>
          album.id === albumId ? { ...album, photoCount: count } : album,
        ),
      );
    } catch (err) {
      log.error(`Failed to update photo count for album ${albumId}:`, err);
    }
  }, []);

  /**
   * Delete an album.
   *
   * This function:
   * 1. Calls the DELETE API endpoint
   * 2. Removes the album from local state
   * 3. Clears any cached data for this album
   *
   * @param albumId - ID of the album to delete
   * @returns true if deletion succeeded, false otherwise
   */
  const deleteAlbum = useCallback(async (albumId: string): Promise<boolean> => {
    try {
      const api = getApi();
      await api.deleteAlbum(albumId);

      // Remove from local state
      setAlbums((prev) => prev.filter((a) => a.id !== albumId));

      // Wipe epoch keys from memory (calls sodium.memzero on key material)
      clearAlbumKeys(albumId);

      // Clear local database photos for this album
      try {
        const db = await getDbClient();
        await db.clearAlbumPhotos(albumId);
      } catch (dbErr) {
        log.error(`Failed to clear local DB data for album ${albumId}:`, dbErr);
      }

      log.info(`Album ${albumId} deleted successfully`);
      return true;
    } catch (err) {
      log.error(`Failed to delete album ${albumId}:`, err);
      return false;
    }
  }, []);

  /**
   * Rename an album with encrypted name.
   *
   * This function:
   * 1. Loads epoch keys for the album
   * 2. Encrypts the new name with the current epoch key
   * 3. Calls the PATCH API endpoint
   * 4. Updates local state with new name
   *
   * @param albumId - ID of the album to rename
   * @param newName - New plain text album name
   * @returns true if rename succeeded, false otherwise
   */
  const renameAlbum = useCallback(
    async (albumId: string, newName: string): Promise<boolean> => {
      try {
        // Load epoch keys for this album
        const keysLoaded = await ensureEpochKeysLoaded(albumId);
        if (!keysLoaded) {
          log.error(`Album ${albumId}: Failed to load epoch keys for rename`);
          throw new Error('Failed to load encryption keys');
        }

        // Get the current epoch key
        const epochKey = getCurrentEpochKey(albumId);
        if (!epochKey) {
          log.error(`Album ${albumId}: No epoch key in cache for rename`);
          throw new Error('Encryption keys not available');
        }

        // Encrypt the new album name
        const encryptedName = await encryptAlbumName(
          newName,
          epochKey.epochSeed,
        );

        // Call API to update the encrypted name
        const api = getApi();
        await api.renameAlbum(albumId, { encryptedName });

        // Update localStorage with new encrypted name
        setStoredEncryptedName(albumId, encryptedName);

        // Update local state with new name
        setAlbums((prev) =>
          prev.map((a) =>
            a.id === albumId
              ? {
                  ...a,
                  name: newName,
                  decryptedName: newName,
                  encryptedName,
                }
              : a,
          ),
        );

        log.info(`Album ${albumId} renamed successfully`);
        return true;
      } catch (err) {
        log.error(`Failed to rename album ${albumId}:`, err);
        throw err;
      }
    },
    [],
  );

  /**
   * Create a new album with encrypted name and initial epoch key.
   *
   * This function:
   * 1. Generates a new epoch key (EpochSeed + SignKeypair)
   * 2. Encrypts the album name with the epoch key
   * 3. Creates the album via API
   * 4. Creates a sealed epoch key bundle for the owner
   * 5. Caches the epoch key locally for immediate use
   *
   * @param name - Plain text album name
   * @param options - Optional expiration settings
   * @returns Created album or null if creation failed
   */
  const createAlbum = useCallback(
    async (name: string, options?: { expiresAt?: string; expirationWarningDays?: number }): Promise<Album | null> => {
      setIsCreating(true);
      setCreateError(null);

      let epochSeedToWipe: Uint8Array | null = null;
      let signSecretKeyToWipe: Uint8Array | null = null;

      try {
        const api = getApi();
        const crypto = await getCryptoClient();

        // Get user's identity public key
        const identityPubkey = await crypto.getIdentityPublicKey();
        if (!identityPubkey) {
          throw new Error('Identity not derived - please log in again');
        }

        // Get current user ID
        const currentUser = await api.getCurrentUser();

        // Generate new epoch key for this album
        const epochId = 1; // Initial epoch
        const epochKey = await crypto.generateEpochKey(epochId);
        epochSeedToWipe = epochKey.epochSeed;
        signSecretKeyToWipe = epochKey.signSecretKey;

        // Encrypt the album name for local storage
        // Note: The encrypted name is stored locally. When we add album metadata
        // support to the API, this can be uploaded as part of the album manifest.
        const encryptedName = await encryptAlbumName(name, epochKey.epochSeed);

        // Create sealed bundle for owner (self-seal)
        const bundle = await crypto.createEpochKeyBundle(
          '', // Bootstrap-only legacy placeholder; strict fetch prefers the corrected re-seal below.
          epochId,
          epochKey.epochSeed,
          epochKey.signPublicKey,
          epochKey.signSecretKey,
          identityPubkey, // Seal to self
        );

        // Create album with initial epoch key and encrypted name
        const newAlbum: ApiAlbum = await api.createAlbum({
          initialEpochKey: {
            recipientId: currentUser.id,
            epochId,
            encryptedKeyBundle: toBase64(
              new Uint8Array([...bundle.signature, ...bundle.encryptedBundle]),
            ),
            ownerSignature: toBase64(bundle.signature),
            sharerPubkey: toBase64(identityPubkey),
            signPubkey: toBase64(epochKey.signPublicKey),
          },
          encryptedName, // Send encrypted name to server
          ...(options?.expiresAt ? { expiresAt: options.expiresAt } : {}),
          ...(options?.expirationWarningDays ? { expirationWarningDays: options.expirationWarningDays } : {}),
        });

        const correctedBundle = await crypto.createEpochKeyBundle(
          newAlbum.id,
          epochId,
          epochKey.epochSeed,
          epochKey.signPublicKey,
          epochKey.signSecretKey,
          identityPubkey,
        );

        try {
          await api.createEpochKey(newAlbum.id, {
            recipientId: currentUser.id,
            epochId,
            encryptedKeyBundle: toBase64(
              new Uint8Array([
                ...correctedBundle.signature,
                ...correctedBundle.encryptedBundle,
              ]),
            ),
            ownerSignature: toBase64(correctedBundle.signature),
            sharerPubkey: toBase64(identityPubkey),
            signPubkey: toBase64(epochKey.signPublicKey),
          });
        } catch (error) {
          try {
            await api.deleteAlbum(newAlbum.id);
          } catch (rollbackError) {
            log.error(
              `Failed to roll back album ${newAlbum.id} after epoch key reseal failure:`,
              rollbackError,
            );
          }
          throw error;
        }

        // Also store in localStorage as a fallback for older server versions
        // Use the service function for consistency
        setStoredEncryptedName(newAlbum.id, encryptedName);

        // Cache the epoch key locally for immediate use
        setEpochKey(newAlbum.id, {
          epochId,
          epochSeed: epochKey.epochSeed,
          signKeypair: {
            publicKey: epochKey.signPublicKey,
            secretKey: epochKey.signSecretKey,
          },
        });
        epochSeedToWipe = null;
        signSecretKeyToWipe = null;

        // Transform to frontend format
        // We know the real name since we just created it
        const album: Album = {
          id: newAlbum.id,
          name, // Display name
          decryptedName: name, // Mark as already decrypted
          photoCount: 0,
          createdAt: newAlbum.createdAt,
          isDecrypting: false,
          decryptionFailed: false,
        };

        // Add to local state
        setAlbums((prev) => [...prev, album]);

        return album;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to create album';
        setCreateError(message);
        return null;
      } finally {
        if (epochSeedToWipe) {
          memzero(epochSeedToWipe);
        }
        if (signSecretKeyToWipe) {
          memzero(signSecretKeyToWipe);
        }
        setIsCreating(false);
      }
    },
    [],
  );

  // Load albums on mount
  useEffect(() => {
    void loadAlbums();
  }, [loadAlbums]);

  // Listen for sync-complete events to update photo counts
  useEffect(() => {
    const handleSyncComplete = (event: Event) => {
      const customEvent = event as CustomEvent<{ albumId: string }>;
      const { albumId } = customEvent.detail;
      if (albumId) {
        void updatePhotoCount(albumId);
      }
    };

    syncEngine.addEventListener('sync-complete', handleSyncComplete);
    return () => {
      syncEngine.removeEventListener('sync-complete', handleSyncComplete);
    };
  }, [updatePhotoCount]);

  return {
    albums,
    isLoading,
    error,
    refetch: loadAlbums,
    createAlbum,
    isCreating,
    createError,
    deleteAlbum,
    renameAlbum,
  };
}
