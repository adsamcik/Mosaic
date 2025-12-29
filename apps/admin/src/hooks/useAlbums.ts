import { useCallback, useEffect, useState } from 'react';
import type { Album } from '../components/Albums/AlbumCard';
import {
    getDecryptedAlbumName,
    getStoredEncryptedName,
    setStoredEncryptedName,
} from '../lib/album-metadata-service';
import { getApi, toBase64 } from '../lib/api';
import type { Album as ApiAlbum } from '../lib/api-types';
import { getCryptoClient } from '../lib/crypto-client';
import { ensureEpochKeysLoaded } from '../lib/epoch-key-service';
import { getCurrentEpochKey, setEpochKey } from '../lib/epoch-key-store';
import { createLogger } from '../lib/logger';

const log = createLogger('useAlbums');

/**
 * Encrypt album name using XChaCha20-Poly1305 with the epoch seed.
 * Uses the envelope format via crypto worker's encryptShard.
 *
 * @param name - Album name to encrypt
 * @param epochSeed - Epoch seed key (32 bytes)
 * @returns Base64-encoded encrypted name
 */
async function encryptAlbumName(name: string, epochSeed: Uint8Array): Promise<string> {
  const crypto = await getCryptoClient();
  const nameBytes = new TextEncoder().encode(name);

  // Use epoch 0, shard 0 for album metadata (reserved)
  const encrypted = await crypto.encryptShard(nameBytes, epochSeed, 0, 0);

  return toBase64(encrypted.ciphertext);
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
      const apiAlbums = await api.listAlbums();

      // Transform API albums to frontend format with placeholder names
      // Names will be decrypted asynchronously after initial load
      const transformedAlbums: Album[] = apiAlbums.map((album) => ({
        id: album.id,
        // Placeholder name until decryption completes
        name: `Album ${album.id.slice(0, 8)}`,
        // Photo count is not returned from API - would need to sync first
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

      // Now decrypt album names asynchronously
      await decryptAlbumNames(transformedAlbums);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    }
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
        const encryptedName = album.encryptedName ?? getStoredEncryptedName(album.id);

        if (!encryptedName) {
          // No encrypted name available - keep placeholder
          // This happens for albums created by other users or before encryption was added
          setAlbums((prev) =>
            prev.map((a) =>
              a.id === album.id ? { ...a, isDecrypting: false } : a
            )
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
                : a
            )
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
                : a
            )
          );
          return;
        }

        // Decrypt the album name
        const decryptedName = await getDecryptedAlbumName(
          album.id,
          encryptedName,
          epochKey.epochSeed
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
              : a
          )
        );
      } catch (err) {
        log.error(`Failed to decrypt album name for ${album.id}:`, err);
        // Mark as failed but keep placeholder name
        setAlbums((prev) =>
          prev.map((a) =>
            a.id === album.id
              ? { ...a, isDecrypting: false, decryptionFailed: true }
              : a
          )
        );
      }
    });

    // Wait for all decryption attempts to complete
    await Promise.all(decryptionPromises);
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
  const deleteAlbum = useCallback(
    async (albumId: string): Promise<boolean> => {
      try {
        const api = getApi();
        await api.deleteAlbum(albumId);

        // Remove from local state
        setAlbums((prev) => prev.filter((a) => a.id !== albumId));

        // Clear cached epoch keys for this album
        // Note: The epoch key store doesn't have a clear function yet,
        // so we just let it expire naturally

        log.info(`Album ${albumId} deleted successfully`);
        return true;
      } catch (err) {
        log.error(`Failed to delete album ${albumId}:`, err);
        return false;
      }
    },
    []
  );

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
        const encryptedName = await encryptAlbumName(newName, epochKey.epochSeed);

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
              : a
          )
        );

        log.info(`Album ${albumId} renamed successfully`);
        return true;
      } catch (err) {
        log.error(`Failed to rename album ${albumId}:`, err);
        throw err;
      }
    },
    []
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
   * @returns Created album or null if creation failed
   */
  const createAlbum = useCallback(
    async (name: string): Promise<Album | null> => {
      setIsCreating(true);
      setCreateError(null);

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

        // Encrypt the album name for local storage
        // Note: The encrypted name is stored locally. When we add album metadata
        // support to the API, this can be uploaded as part of the album manifest.
        const encryptedName = await encryptAlbumName(name, epochKey.epochSeed);

        // Create sealed bundle for owner (self-seal)
        const bundle = await crypto.createEpochKeyBundle(
          '', // Album ID not known yet - will be set by server
          epochId,
          epochKey.epochSeed,
          epochKey.signPublicKey,
          epochKey.signSecretKey,
          identityPubkey // Seal to self
        );

        // Create album with initial epoch key and encrypted name
        const newAlbum: ApiAlbum = await api.createAlbum({
          initialEpochKey: {
            recipientId: currentUser.id,
            epochId,
            encryptedKeyBundle: toBase64(
              new Uint8Array([...bundle.signature, ...bundle.encryptedBundle])
            ),
            ownerSignature: toBase64(bundle.signature),
            sharerPubkey: toBase64(identityPubkey),
            signPubkey: toBase64(epochKey.signPublicKey),
          },
          encryptedName, // Send encrypted name to server
        });

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
        const message = err instanceof Error ? err.message : 'Failed to create album';
        setCreateError(message);
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    []
  );

  useEffect(() => {
    void loadAlbums();
  }, [loadAlbums]);

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
