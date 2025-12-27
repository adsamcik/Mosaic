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

/**
 * Encrypt album name using XChaCha20-Poly1305 with the epoch read key.
 * Uses the envelope format via crypto worker's encryptShard.
 *
 * @param name - Album name to encrypt
 * @param readKey - Epoch read key (32 bytes)
 * @returns Base64-encoded encrypted name
 */
async function encryptAlbumName(name: string, readKey: Uint8Array): Promise<string> {
  const crypto = await getCryptoClient();
  const nameBytes = new TextEncoder().encode(name);

  // Use epoch 0, shard 0 for album metadata (reserved)
  const encrypted = await crypto.encryptShard(nameBytes, readKey, 0, 0);

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
        // Try to get encrypted name from localStorage
        // (This is where we store it during album creation until server support)
        const encryptedName = getStoredEncryptedName(album.id);

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
          epochKey.readKey
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
        console.error(`Failed to decrypt album name for ${album.id}:`, err);
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
   * Create a new album with encrypted name and initial epoch key.
   *
   * This function:
   * 1. Generates a new epoch key (ReadKey + SignKeypair)
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
        const encryptedName = await encryptAlbumName(name, epochKey.readKey);

        // Create sealed bundle for owner (self-seal)
        const bundle = await crypto.createEpochKeyBundle(
          '', // Album ID not known yet - will be set by server
          epochId,
          epochKey.readKey,
          epochKey.signPublicKey,
          epochKey.signSecretKey,
          identityPubkey // Seal to self
        );

        // Create album with initial epoch key
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
        });

        // Update the localStorage key with the actual album ID
        // Use the service function for consistency
        setStoredEncryptedName(newAlbum.id, encryptedName);

        // Cache the epoch key locally for immediate use
        setEpochKey(newAlbum.id, {
          epochId,
          readKey: epochKey.readKey,
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
  };
}
