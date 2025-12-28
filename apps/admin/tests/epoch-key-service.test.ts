/**
 * Epoch Key Service Unit Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochKeyRecord } from '../src/lib/api-types';
import {
    ensureEpochKeysLoaded,
    EpochKeyError,
    EpochKeyErrorCode,
    fetchAndUnwrapEpochKeys,
    getCurrentOrFetchEpochKey,
    getOrFetchEpochKey,
} from '../src/lib/epoch-key-service';
import { clearAllEpochKeys, getEpochKey, setEpochKey } from '../src/lib/epoch-key-store';

// Mock the API client
vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => mockApi),
  fromBase64: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
}));

// Mock the crypto client
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() => Promise.resolve(mockCryptoClient)),
}));

// Mock API implementation
const mockApi = {
  getEpochKeys: vi.fn(),
};

// Mock crypto client implementation
const mockCryptoClient = {
  getIdentityPublicKey: vi.fn(),
  deriveIdentity: vi.fn(),
  openEpochKeyBundle: vi.fn(),
};

// Helper to create base64-encoded test data
function toBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}

// Create a mock epoch key record
function createMockEpochKeyRecord(epochId: number): EpochKeyRecord {
  return {
    id: `key-${epochId}`,
    albumId: 'album-123',
    epochId,
    encryptedKeyBundle: toBase64(new Uint8Array(100)), // Mock sealed box
    ownerSignature: toBase64(new Uint8Array(64)), // Mock signature
    sharerPubkey: toBase64(new Uint8Array(32)), // Mock pubkey
    signPubkey: toBase64(new Uint8Array(32)),
    createdAt: new Date().toISOString(),
  };
}

describe('Epoch Key Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllEpochKeys();

    // Default mock implementations
    mockCryptoClient.getIdentityPublicKey.mockResolvedValue(new Uint8Array(32));
    mockCryptoClient.deriveIdentity.mockResolvedValue(undefined);
    mockCryptoClient.openEpochKeyBundle.mockImplementation(
      async (_bundle, _sender, albumId, _minEpoch) => ({
        epochSeed: new Uint8Array(32).fill(1),
        signPublicKey: new Uint8Array(32).fill(2),
        signSecretKey: new Uint8Array(64).fill(3),
      })
    );
    mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);
  });

  afterEach(() => {
    clearAllEpochKeys();
  });

  describe('EpochKeyError', () => {
    it('creates error with code and cause', () => {
      const cause = new Error('Original error');
      const error = new EpochKeyError(
        'Test error',
        EpochKeyErrorCode.FETCH_FAILED,
        cause
      );

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(EpochKeyErrorCode.FETCH_FAILED);
      expect(error.cause).toBe(cause);
      expect(error.name).toBe('EpochKeyError');
    });
  });

  describe('fetchAndUnwrapEpochKeys', () => {
    it('fetches and unwraps epoch keys from server', async () => {
      const records = [createMockEpochKeyRecord(1), createMockEpochKeyRecord(2)];
      mockApi.getEpochKeys.mockResolvedValue(records);

      const bundles = await fetchAndUnwrapEpochKeys('album-123');

      expect(bundles).toHaveLength(2);
      expect(bundles[0].epochId).toBe(1);
      expect(bundles[1].epochId).toBe(2);
      expect(mockApi.getEpochKeys).toHaveBeenCalledWith('album-123');
    });

    it('caches unwrapped keys', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);

      await fetchAndUnwrapEpochKeys('album-123');

      const cached = getEpochKey('album-123', 1);
      expect(cached).not.toBeNull();
      expect(cached?.epochId).toBe(1);
    });

    it('skips already cached keys', async () => {
      // Pre-cache a key
      setEpochKey('album-123', {
        epochId: 1,
        epochSeed: new Uint8Array(32).fill(99),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);

      const bundles = await fetchAndUnwrapEpochKeys('album-123');

      // Should return the cached key
      expect(bundles[0].epochSeed[0]).toBe(99);
      // Should not have called openEpochKeyBundle
      expect(mockCryptoClient.openEpochKeyBundle).not.toHaveBeenCalled();
    });

    it('skips epochs below minEpochId', async () => {
      const records = [
        createMockEpochKeyRecord(1),
        createMockEpochKeyRecord(2),
        createMockEpochKeyRecord(3),
      ];
      mockApi.getEpochKeys.mockResolvedValue(records);

      const bundles = await fetchAndUnwrapEpochKeys('album-123', 2);

      expect(bundles).toHaveLength(2);
      expect(bundles.map((b) => b.epochId)).toEqual([2, 3]);
    });

    it('throws IDENTITY_NOT_DERIVED when identity not available', async () => {
      mockCryptoClient.getIdentityPublicKey.mockResolvedValue(null);
      mockCryptoClient.deriveIdentity.mockRejectedValue(
        new Error('Not initialized')
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.IDENTITY_NOT_DERIVED
        );
      }
    });

    it('throws FETCH_FAILED when API fails', async () => {
      mockApi.getEpochKeys.mockRejectedValue(new Error('Network error'));

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(EpochKeyErrorCode.FETCH_FAILED);
      }
    });

    it('throws NO_KEYS_AVAILABLE when server returns empty array', async () => {
      mockApi.getEpochKeys.mockResolvedValue([]);

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.NO_KEYS_AVAILABLE
        );
      }
    });

    it('throws SIGNATURE_INVALID on signature error', async () => {
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Invalid signature - not from claimed owner')
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.SIGNATURE_INVALID
        );
      }
    });

    it('throws DECRYPTION_FAILED on decryption error', async () => {
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Failed to decrypt - not intended for this recipient')
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.DECRYPTION_FAILED
        );
      }
    });

    it('throws CONTEXT_MISMATCH on context error', async () => {
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Bundle albumId mismatch: expected X, got Y')
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.CONTEXT_MISMATCH
        );
      }
    });

    it('derives identity if not already derived', async () => {
      mockCryptoClient.getIdentityPublicKey.mockResolvedValue(null);
      mockCryptoClient.deriveIdentity.mockResolvedValue(undefined);
      // After derive, identity is available
      mockCryptoClient.getIdentityPublicKey.mockResolvedValueOnce(null);

      await fetchAndUnwrapEpochKeys('album-123');

      expect(mockCryptoClient.deriveIdentity).toHaveBeenCalled();
    });
  });

  describe('getOrFetchEpochKey', () => {
    it('returns cached key without fetching', async () => {
      setEpochKey('album-123', {
        epochId: 5,
        epochSeed: new Uint8Array(32).fill(55),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      const bundle = await getOrFetchEpochKey('album-123', 5);

      expect(bundle.epochId).toBe(5);
      expect(bundle.epochSeed[0]).toBe(55);
      expect(mockApi.getEpochKeys).not.toHaveBeenCalled();
    });

    it('fetches and returns key when not cached', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(3)]);

      const bundle = await getOrFetchEpochKey('album-123', 3);

      expect(bundle.epochId).toBe(3);
      expect(mockApi.getEpochKeys).toHaveBeenCalledWith('album-123');
    });

    it('throws when requested epoch not found after fetch', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);

      await expect(getOrFetchEpochKey('album-123', 999)).rejects.toThrow(
        EpochKeyError
      );

      try {
        await getOrFetchEpochKey('album-123', 999);
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.NO_KEYS_AVAILABLE
        );
      }
    });
  });

  describe('getCurrentOrFetchEpochKey', () => {
    it('returns cached current key without fetching', async () => {
      setEpochKey('album-123', {
        epochId: 10,
        epochSeed: new Uint8Array(32).fill(10),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });
      setEpochKey('album-123', {
        epochId: 5,
        epochSeed: new Uint8Array(32).fill(5),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      const bundle = await getCurrentOrFetchEpochKey('album-123');

      expect(bundle.epochId).toBe(10); // Highest epoch
      expect(mockApi.getEpochKeys).not.toHaveBeenCalled();
    });

    it('fetches and returns current key when not cached', async () => {
      const records = [
        createMockEpochKeyRecord(1),
        createMockEpochKeyRecord(5),
        createMockEpochKeyRecord(3),
      ];
      mockApi.getEpochKeys.mockResolvedValue(records);

      // Mock to return different epoch IDs
      let callCount = 0;
      mockCryptoClient.openEpochKeyBundle.mockImplementation(async () => {
        const epochId = records[callCount++]?.epochId ?? 1;
        return {
          epochSeed: new Uint8Array(32).fill(epochId),
          signPublicKey: new Uint8Array(32),
          signSecretKey: new Uint8Array(64),
        };
      });

      const bundle = await getCurrentOrFetchEpochKey('album-123');

      // Should return highest epoch (5)
      expect(bundle.epochId).toBe(5);
    });
  });

  describe('ensureEpochKeysLoaded', () => {
    it('returns true immediately if keys are cached', async () => {
      setEpochKey('album-123', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      const result = await ensureEpochKeysLoaded('album-123');

      expect(result).toBe(true);
      expect(mockApi.getEpochKeys).not.toHaveBeenCalled();
    });

    it('fetches keys when not cached', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);

      const result = await ensureEpochKeysLoaded('album-123');

      expect(result).toBe(true);
      expect(mockApi.getEpochKeys).toHaveBeenCalled();
    });

    it('returns false on error without throwing', async () => {
      mockApi.getEpochKeys.mockRejectedValue(new Error('Network error'));

      const result = await ensureEpochKeysLoaded('album-123');

      expect(result).toBe(false);
    });
  });

  describe('bundle format handling', () => {
    it('passes encryptedKeyBundle directly without prepending signature (regression test for duplicated signature bug)', async () => {
      // Create a record where encryptedKeyBundle already contains signature || sealed
      // This matches the format sent by useAlbums.ts when creating albums
      const signature = new Uint8Array(64).fill(0xAA);
      const sealedBox = new Uint8Array(50).fill(0xBB);
      const fullBundle = new Uint8Array([...signature, ...sealedBox]);

      const record: EpochKeyRecord = {
        id: 'key-1',
        albumId: 'album-regression',
        epochId: 1,
        encryptedKeyBundle: toBase64(fullBundle), // signature || sealed already combined
        ownerSignature: toBase64(signature), // signature stored separately too
        sharerPubkey: toBase64(new Uint8Array(32).fill(0xCC)),
        signPubkey: toBase64(new Uint8Array(32)),
        createdAt: new Date().toISOString(),
      };

      mockApi.getEpochKeys.mockResolvedValue([record]);

      await fetchAndUnwrapEpochKeys('album-regression');

      // Verify openEpochKeyBundle was called with the encryptedKeyBundle directly
      // NOT with signature prepended again (which would be 64 + 114 = 178 bytes)
      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenCalledTimes(1);
      const calledBundle = mockCryptoClient.openEpochKeyBundle.mock.calls[0][0] as Uint8Array;

      // The bundle should be exactly what was in encryptedKeyBundle (114 bytes = 64 + 50)
      // NOT 178 bytes (signature prepended again)
      expect(calledBundle.length).toBe(fullBundle.length);
      expect(calledBundle).toEqual(fullBundle);

      // Verify the first 64 bytes are the signature
      expect(calledBundle.slice(0, 64)).toEqual(signature);
      // Verify the remaining bytes are the sealed box
      expect(calledBundle.slice(64)).toEqual(sealedBox);
    });
  });
});
