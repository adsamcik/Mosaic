import { useState, useEffect, useCallback } from 'react';
import { getApi, toBase64 } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import { setEpochKey } from '../lib/epoch-key-store';
import type { Album } from '../components/Albums/AlbumCard';
import type { Album as ApiAlbum } from '../lib/api-types';

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
        // Store encrypted name in local storage for now
        // This will be replaced with proper manifest storage when album metadata is supported
        localStorage.setItem(`mosaic:album:${name}:encryptedName`, encryptedName);

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
        localStorage.removeItem(`mosaic:album:${name}:encryptedName`);
        localStorage.setItem(`mosaic:album:${newAlbum.id}:encryptedName`, encryptedName);

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
        const album: Album = {
          id: newAlbum.id,
          name, // We know the real name since we just created it
          photoCount: 0,
          createdAt: newAlbum.createdAt,
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
