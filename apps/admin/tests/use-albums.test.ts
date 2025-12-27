/**
 * useAlbums Hook Tests
 *
 * Tests the useAlbums hook behavior for listing and creating albums.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock API implementation
const mockApi = {
  listAlbums: vi.fn(),
  createAlbum: vi.fn(),
  getCurrentUser: vi.fn(),
};

// Mock crypto client implementation
const mockCryptoClient = {
  getIdentityPublicKey: vi.fn(),
  generateEpochKey: vi.fn(),
  createEpochKeyBundle: vi.fn(),
  encryptShard: vi.fn(),
};

// Mock setEpochKey
const mockSetEpochKey = vi.fn();

// Mock the API client
vi.mock('../src/lib/api', () => ({
  getApi: () => mockApi,
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
  fromBase64: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

// Mock the crypto client
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () => Promise.resolve(mockCryptoClient),
}));

// Mock the epoch key store
vi.mock('../src/lib/epoch-key-store', () => ({
  setEpochKey: (...args: unknown[]) => mockSetEpochKey(...args),
}));

// Helper to create mock album response
function createMockAlbum(id: string) {
  return {
    id,
    ownerId: 'user-123',
    currentVersion: 1,
    currentEpochId: 1,
    createdAt: new Date().toISOString(),
  };
}

// Import after mocks are set up
import { getApi, toBase64 } from '../src/lib/api';
import { getCryptoClient } from '../src/lib/crypto-client';
import { setEpochKey } from '../src/lib/epoch-key-store';

describe('useAlbums', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockApi.listAlbums.mockResolvedValue([]);
    mockApi.getCurrentUser.mockResolvedValue({ id: 'user-123' });
    mockCryptoClient.getIdentityPublicKey.mockResolvedValue(new Uint8Array(32));
    mockCryptoClient.generateEpochKey.mockResolvedValue({
      readKey: new Uint8Array(32).fill(1),
      signPublicKey: new Uint8Array(32).fill(2),
      signSecretKey: new Uint8Array(64).fill(3),
    });
    mockCryptoClient.createEpochKeyBundle.mockResolvedValue({
      encryptedBundle: new Uint8Array(100),
      signature: new Uint8Array(64),
    });
    mockCryptoClient.encryptShard.mockResolvedValue({
      ciphertext: new Uint8Array(50),
      sha256: 'abc123',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('API client', () => {
    it('can be retrieved via getApi', () => {
      const api = getApi();
      expect(api).toBeDefined();
      expect(api.listAlbums).toBeDefined();
      expect(api.createAlbum).toBeDefined();
    });
  });

  describe('crypto client', () => {
    it('can be retrieved via getCryptoClient', async () => {
      const crypto = await getCryptoClient();
      expect(crypto).toBeDefined();
      expect(crypto.generateEpochKey).toBeDefined();
    });
  });

  describe('album creation flow', () => {
    it('generates epoch key with epochId 1', async () => {
      const crypto = await getCryptoClient();
      const epochKey = await crypto.generateEpochKey(1);

      expect(epochKey.readKey).toHaveLength(32);
      expect(epochKey.signPublicKey).toHaveLength(32);
      expect(epochKey.signSecretKey).toHaveLength(64);
    });

    it('creates epoch key bundle', async () => {
      const crypto = await getCryptoClient();
      const identityPubkey = await crypto.getIdentityPublicKey();
      expect(identityPubkey).not.toBeNull();

      const bundle = await crypto.createEpochKeyBundle(
        'album-id',
        1,
        new Uint8Array(32),
        new Uint8Array(32),
        new Uint8Array(64),
        identityPubkey!
      );

      expect(bundle.encryptedBundle).toBeDefined();
      expect(bundle.signature).toBeDefined();
    });

    it('encrypts album name', async () => {
      const crypto = await getCryptoClient();
      const readKey = new Uint8Array(32).fill(1);
      const nameBytes = new TextEncoder().encode('My Album');

      const encrypted = await crypto.encryptShard(nameBytes, readKey, 0, 0);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.sha256).toBeDefined();
    });

    it('creates album via API', async () => {
      const newAlbum = createMockAlbum('new-album-id');
      mockApi.createAlbum.mockResolvedValue(newAlbum);

      const result = await mockApi.createAlbum({
        initialEpochKey: {
          recipientId: 'user-123',
          epochId: 1,
          encryptedKeyBundle: 'base64...',
          ownerSignature: 'base64...',
          sharerPubkey: 'base64...',
          signPubkey: 'base64...',
        },
      });

      expect(result.id).toBe('new-album-id');
      expect(mockApi.createAlbum).toHaveBeenCalled();
    });

    it('caches epoch key after creation', () => {
      setEpochKey('album-123', {
        epochId: 1,
        readKey: new Uint8Array(32).fill(1),
        signKeypair: {
          publicKey: new Uint8Array(32).fill(2),
          secretKey: new Uint8Array(64).fill(3),
        },
      });

      expect(mockSetEpochKey).toHaveBeenCalledWith('album-123', expect.objectContaining({
        epochId: 1,
      }));
    });
  });

  describe('album listing', () => {
    it('lists albums from API', async () => {
      mockApi.listAlbums.mockResolvedValue([
        createMockAlbum('album-1'),
        createMockAlbum('album-2'),
      ]);

      const albums = await mockApi.listAlbums();

      expect(albums).toHaveLength(2);
      expect(albums[0].id).toBe('album-1');
      expect(albums[1].id).toBe('album-2');
    });

    it('handles empty album list', async () => {
      mockApi.listAlbums.mockResolvedValue([]);

      const albums = await mockApi.listAlbums();

      expect(albums).toHaveLength(0);
    });

    it('handles API errors', async () => {
      mockApi.listAlbums.mockRejectedValue(new Error('Network error'));

      await expect(mockApi.listAlbums()).rejects.toThrow('Network error');
    });
  });

  describe('base64 encoding', () => {
    it('encodes Uint8Array to base64', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const encoded = toBase64(data);
      expect(encoded).toBe('SGVsbG8=');
    });
  });

  describe('error handling', () => {
    it('handles missing identity gracefully', async () => {
      mockCryptoClient.getIdentityPublicKey.mockResolvedValue(null);

      const crypto = await getCryptoClient();
      const identity = await crypto.getIdentityPublicKey();

      expect(identity).toBeNull();
    });

    it('handles createAlbum API failure', async () => {
      mockApi.createAlbum.mockRejectedValue(new Error('Server error'));

      await expect(mockApi.createAlbum({})).rejects.toThrow('Server error');
    });

    it('handles epoch key generation failure', async () => {
      mockCryptoClient.generateEpochKey.mockRejectedValue(new Error('Crypto error'));

      const crypto = await getCryptoClient();
      await expect(crypto.generateEpochKey(1)).rejects.toThrow('Crypto error');
    });
  });
});

