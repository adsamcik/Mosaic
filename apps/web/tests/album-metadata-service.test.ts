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
  decryptAlbumNameWithTierKey,
  getCachedMetadata,
  getStoredEncryptedName,
  setCachedMetadata,
  setStoredEncryptedName,
} from '../src/lib/album-metadata-service';

// Mock the crypto client
const mockCryptoClient = {
  decryptShard: vi.fn(),
  decryptShardWithTierKey: vi.fn(),
  decryptShardWithLinkTierHandle: vi.fn(),
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

  describe('decryptAlbumNameWithTierKey', () => {
    it('decrypts album name using tier key directly (for share links)', async () => {
      const albumName = 'Shared Album Name';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const tierKey = 'link-tier-handle-2' as never;

      mockCryptoClient.decryptShardWithLinkTierHandle.mockResolvedValue(
        new TextEncoder().encode(albumName),
      );

      const result = await decryptAlbumNameWithTierKey(
        encryptedBytes,
        tierKey,
        'album-shared',
      );

      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShardWithLinkTierHandle).toHaveBeenCalledWith(
        tierKey,
        encryptedBytes,
      );
      // Should NOT call decryptShard (which derives tier keys)
      expect(mockCryptoClient.decryptShard).not.toHaveBeenCalled();
      expect(mockCryptoClient.decryptShardWithTierKey).not.toHaveBeenCalled();
    });

    it('decrypts album name from base64 string with tier key', async () => {
      const albumName = 'Base64 Shared Album';
      const encryptedBytes = createEncryptedNameBytes(albumName);
      const base64Encrypted = toBase64(encryptedBytes);
      const tierKey = new Uint8Array(32).fill(3);

      mockCryptoClient.decryptShardWithTierKey.mockResolvedValue(
        new TextEncoder().encode(albumName),
      );

      const result = await decryptAlbumNameWithTierKey(
        base64Encrypted,
        tierKey,
        'album-shared',
      );

      expect(result).toBe(albumName);
      expect(mockCryptoClient.decryptShardWithTierKey).toHaveBeenCalled();
    });

    it('throws error for empty encrypted name', async () => {
      const tierKey = new Uint8Array(32).fill(1);

      await expect(
        decryptAlbumNameWithTierKey(new Uint8Array(0), tierKey, 'album-shared'),
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('throws error for invalid tier key length', async () => {
      const encryptedBytes = createEncryptedNameBytes('Test');
      const invalidKey = new Uint8Array(16); // Should be 32 bytes

      await expect(
        decryptAlbumNameWithTierKey(encryptedBytes, invalidKey, 'album-shared'),
      ).rejects.toThrow(AlbumMetadataError);
    });

    it('throws AlbumMetadataError on decryption failure', async () => {
      const encryptedBytes = createEncryptedNameBytes('Test');
      const tierKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShardWithTierKey.mockRejectedValue(
        new Error('Decryption failed - wrong key or tampered data'),
      );

      await expect(
        decryptAlbumNameWithTierKey(encryptedBytes, tierKey, 'album-shared'),
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

      expect(
        localStorage.getItem('mosaic:album:my-album-id:encryptedName'),
      ).toBe(encryptedName);
    });
  });

  describe('edge cases', () => {
    it('handles empty album name', async () => {
      const albumName = '';
      const tierKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShardWithTierKey.mockResolvedValue(
        new Uint8Array(0),
      );

      const result = await decryptAlbumNameWithTierKey(
        new Uint8Array([1]), // Some encrypted content
        tierKey,
        'album-123',
      );

      expect(result).toBe('');
    });

    it('handles very long album names', async () => {
      const albumName = 'A'.repeat(1000);
      const tierKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShardWithTierKey.mockResolvedValue(
        new TextEncoder().encode(albumName),
      );

      const result = await decryptAlbumNameWithTierKey(
        createEncryptedNameBytes(albumName),
        tierKey,
        'album-123',
      );

      expect(result).toBe(albumName);
      expect(result.length).toBe(1000);
    });

    it('handles album names with special characters', async () => {
      const albumName = '<script>alert("XSS")</script> & "quotes" \'single\'';
      const tierKey = new Uint8Array(32).fill(1);

      mockCryptoClient.decryptShardWithTierKey.mockResolvedValue(
        new TextEncoder().encode(albumName),
      );

      const result = await decryptAlbumNameWithTierKey(
        createEncryptedNameBytes(albumName),
        tierKey,
        'album-123',
      );

      expect(result).toBe(albumName);
    });
  });
});
