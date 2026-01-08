/**
 * Album Metadata Service Tests
 *
 * Tests for album name decryption and caching functionality.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AlbumMetadataError,
    clearAllCachedMetadata,
    clearCachedMetadata,
    clearStoredEncryptedName,
    decryptAlbumName,
    decryptAlbumNameWithTierKey,
    getCachedMetadata,
    getDecryptedAlbumName,
    getStoredEncryptedName,
    setCachedMetadata,
    setStoredEncryptedName,
} from '../src/lib/album-metadata-service';

// Mock the crypto client
const mockCryptoClient = {
  decryptShard: vi.fn(),
  decryptShardWithTierKey: vi.fn(),
};

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() => Promise.resolve(mockCryptoClient)),
}));

// Mock the api module for fromBase64
vi.mock('../src/lib/api', () => ({
  fromBase64: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
}));

// Helper to create a base64 string
function toBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}

// Helper to create encrypted name bytes (simulated envelope)
function createEncryptedNameBytes(name: string): Uint8Array {
  // In real usage, this would be a 64-byte header + encrypted content
  // For testing, we just use the name bytes directly
  const encoder = new TextEncoder();
  return encoder.encode(name);
}

describe('Album Metadata Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCachedMetadata();
    localStorage.clear();
  });

  afterEach(() => {
    clearAllCachedMetadata();
    localStorage.clear();
  });

  describe('AlbumMetadataError', () => {
    it('creates error with albumId and cause', () => {
      const cause = new Error('Original error');
      const error = new AlbumMetadataError('Test error', 'album-123', cause);

      expect(error.message).toBe('Test error');
      expect(error.albumId).toBe('album-123');
      expect(error.cause).toBe(cause);
      expect(error.name).toBe('AlbumMetadataError');
    });

    it('creates error without cause', () => {
      const error = new AlbumMetadataError('Test error', 'album-123');

      expect(error.message).toBe('Test error');
      expect(error.albumId).toBe('album-123');
      expect(error.cause).toBeUndefined();
    });
  });

  describe('decryptAlbumName', () => {
    it('decrypts album name from Uint8Array', async () => {
      const albumName = 'My Test Album';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const readKey = new Uint8Array(32).fill(1);

      // Mock the decryptShard to return the decrypted name bytes
      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumName(encryptedBytes, readKey, 'album-123');

      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShard).toHaveBeenCalledWith(
        encryptedBytes,
        readKey
      );
    });

    it('decrypts album name from base64 string', async () => {
      const albumName = 'My Test Album';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const base64Encrypted = toBase64(encryptedBytes);
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumName(base64Encrypted, readKey, 'album-123');

      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShard).toHaveBeenCalled();
    });

    it('throws error for empty encrypted name', async () => {
      const readKey = new Uint8Array(32).fill(1);

      await expect(
        decryptAlbumName(new Uint8Array(0), readKey, 'album-123')
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('throws error for invalid read key length', async () => {
      const encryptedBytes = createEncryptedNameBytes('Test');
      const invalidKey = new Uint8Array(16); // Should be 32 bytes

      await expect(
        decryptAlbumName(encryptedBytes, invalidKey, 'album-123')
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('throws AlbumMetadataError on decryption failure', async () => {
      const encryptedBytes = createEncryptedNameBytes('Test');
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockRejectedValue(new Error('Decryption failed'));

      await expect(
        decryptAlbumName(encryptedBytes, readKey, 'album-123')
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('handles unicode album names', async () => {
      const albumName = '相册名称 📷 Álbum';
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumName(
        createEncryptedNameBytes(albumName),
        readKey,
        'album-123'
      );

      expect(result).toBe(albumName);
    });
  });

  describe('decryptAlbumNameWithTierKey', () => {
    it('decrypts album name using tier key directly (for share links)', async () => {
      const albumName = 'Shared Album Name';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const tierKey = new Uint8Array(32).fill(2); // Tier key, not epoch seed

      // Mock decryptShardWithTierKey for share link context
      mockCryptoClient.decryptShardWithTierKey.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumNameWithTierKey(encryptedBytes, tierKey, 'album-shared');

      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShardWithTierKey).toHaveBeenCalledWith(
        encryptedBytes,
        tierKey
      );
      // Should NOT call decryptShard (which derives tier keys)
      expect(mockCryptoClient.decryptShard).not.toHaveBeenCalled();
    });

    it('decrypts album name from base64 string with tier key', async () => {
      const albumName = 'Base64 Shared Album';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const base64Encrypted = toBase64(encryptedBytes);
      const tierKey = new Uint8Array(32).fill(3);

      mockCryptoClient.decryptShardWithTierKey.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumNameWithTierKey(base64Encrypted, tierKey, 'album-shared');

      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShardWithTierKey).toHaveBeenCalled();
    });

    it('throws error for empty encrypted name', async () => {
      const tierKey = new Uint8Array(32).fill(1);

      await expect(
        decryptAlbumNameWithTierKey(new Uint8Array(0), tierKey, 'album-shared')
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('throws error for invalid tier key length', async () => {
      const encryptedBytes = createEncryptedNameBytes('Test');
      const invalidKey = new Uint8Array(16); // Should be 32 bytes

      await expect(
        decryptAlbumNameWithTierKey(encryptedBytes, invalidKey, 'album-shared')
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('throws AlbumMetadataError on decryption failure', async () => {
      const encryptedBytes = createEncryptedNameBytes('Test');
      const tierKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShardWithTierKey.mockRejectedValue(
        new Error('Decryption failed - wrong key or tampered data')
      );

      await expect(
        decryptAlbumNameWithTierKey(encryptedBytes, tierKey, 'album-shared')
      ).rejects.toThrow(AlbumMetadataError);
    });
  });

  describe('metadata cache', () => {
    it('getCachedMetadata returns null for uncached album', () => {
      const result = getCachedMetadata('album-123');
      expect(result).toBeNull();
    });

    it('setCachedMetadata stores metadata', () => {
      setCachedMetadata('album-123', { name: 'My Album' });

      const result = getCachedMetadata('album-123');
      expect(result).toEqual({ name: 'My Album' });
    });

    it('clearCachedMetadata removes specific album', () => {
      setCachedMetadata('album-1', { name: 'Album 1' });
      setCachedMetadata('album-2', { name: 'Album 2' });

      clearCachedMetadata('album-1');

      expect(getCachedMetadata('album-1')).toBeNull();
      expect(getCachedMetadata('album-2')).toEqual({ name: 'Album 2' });
    });

    it('clearAllCachedMetadata removes all albums', () => {
      setCachedMetadata('album-1', { name: 'Album 1' });
      setCachedMetadata('album-2', { name: 'Album 2' });

      clearAllCachedMetadata();

      expect(getCachedMetadata('album-1')).toBeNull();
      expect(getCachedMetadata('album-2')).toBeNull();
    });
  });

  describe('getDecryptedAlbumName', () => {
    it('returns cached name without decrypting again', async () => {
      setCachedMetadata('album-123', { name: 'Cached Album' });

      const result = await getDecryptedAlbumName(
        'album-123',
        new Uint8Array(10),
        new Uint8Array(32)
      );

      expect(result).toBe('Cached Album');
      expect(mockCryptoClient.decryptShard).not.toHaveBeenCalled();
    });

    it('decrypts and caches name on first call', async () => {
      const albumName = 'New Album';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await getDecryptedAlbumName('album-123', encryptedBytes, readKey);

      expect(result).toBe(albumName);
      expect(getCachedMetadata('album-123')).toEqual({ name: albumName });
    });

    it('subsequent calls use cache', async () => {
      const albumName = 'My Album';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      // First call - should decrypt
      await getDecryptedAlbumName('album-123', encryptedBytes, readKey);
      expect(mockCryptoClient.decryptShard).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result = await getDecryptedAlbumName('album-123', encryptedBytes, readKey);
      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShard).toHaveBeenCalledTimes(1);
    });
  });

  describe('localStorage helpers', () => {
    it('getStoredEncryptedName returns null for missing key', () => {
      const result = getStoredEncryptedName('album-123');
      expect(result).toBeNull();
    });

    it('setStoredEncryptedName stores encrypted name', () => {
      const encryptedName = toBase64(new Uint8Array([1, 2, 3, 4]));

      setStoredEncryptedName('album-123', encryptedName);

      const result = getStoredEncryptedName('album-123');
      expect(result).toBe(encryptedName);
    });

    it('clearStoredEncryptedName removes encrypted name', () => {
      const encryptedName = toBase64(new Uint8Array([1, 2, 3, 4]));
      setStoredEncryptedName('album-123', encryptedName);

      clearStoredEncryptedName('album-123');

      expect(getStoredEncryptedName('album-123')).toBeNull();
    });

    it('stores in correct localStorage key format', () => {
      const encryptedName = 'encrypted-data';
      setStoredEncryptedName('my-album-id', encryptedName);

      expect(localStorage.getItem('mosaic:album:my-album-id:encryptedName')).toBe(
        encryptedName
      );
    });
  });

  describe('edge cases', () => {
    it('handles empty album name', async () => {
      const albumName = '';
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(new Uint8Array(0));

      const result = await decryptAlbumName(
        new Uint8Array([1]), // Some encrypted content
        readKey,
        'album-123'
      );

      expect(result).toBe('');
    });

    it('handles very long album names', async () => {
      const albumName = 'A'.repeat(1000);
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumName(
        createEncryptedNameBytes(albumName),
        readKey,
        'album-123'
      );

      expect(result).toBe(albumName);
      expect(result.length).toBe(1000);
    });

    it('handles album names with special characters', async () => {
      const albumName = '<script>alert("XSS")</script> & "quotes" \'single\'';
      const readKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShard.mockResolvedValue(
        new TextEncoder().encode(albumName)
      );

      const result = await decryptAlbumName(
        createEncryptedNameBytes(albumName),
        readKey,
        'album-123'
      );

      expect(result).toBe(albumName);
    });
  });
});
