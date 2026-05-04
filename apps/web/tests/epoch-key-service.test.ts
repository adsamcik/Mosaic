/**
 * Epoch Key Service Unit Tests
 *
 * Slice 3 — `openEpochKeyBundle` returns an opaque epoch handle id (no raw
 * seed/sign-secret bytes); the cache stores `{ epochHandleId, signPublicKey }`
 * and the legacy fields are zero-filled placeholders during the multi-slice
 * cutover.
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
import {
  clearAllEpochKeys,
  getEpochKey,
  setEpochKey,
} from '../src/lib/epoch-key-store';

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
  closeEpochHandle: vi.fn(async (_handleId: string) => undefined),
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
    encryptedKeyBundle: toBase64(new Uint8Array(100)),
    ownerSignature: toBase64(new Uint8Array(64)),
    sharerPubkey: toBase64(new Uint8Array(32)),
    signPubkey: toBase64(new Uint8Array(32)),
    createdAt: new Date().toISOString(),
  };
}

describe('Epoch Key Service', () => {
  let nextHandleId = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllEpochKeys();
    nextHandleId = 0;

    mockCryptoClient.getIdentityPublicKey.mockResolvedValue(new Uint8Array(32));
    mockCryptoClient.deriveIdentity.mockResolvedValue(undefined);
    mockCryptoClient.openEpochKeyBundle.mockImplementation(
      async (_bundle, _sender, _albumId, _minEpoch) => {
        nextHandleId += 1;
        return {
          epochHandleId: `epch_test-${String(nextHandleId)}`,
          epochId: nextHandleId,
          signPublicKey: new Uint8Array(32).fill(2),
        };
      },
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
        cause,
      );

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(EpochKeyErrorCode.FETCH_FAILED);
      expect(error.cause).toBe(cause);
      expect(error.name).toBe('EpochKeyError');
    });
  });

  describe('fetchAndUnwrapEpochKeys', () => {
    it('fetches and unwraps epoch keys from server', async () => {
      const records = [
        createMockEpochKeyRecord(1),
        createMockEpochKeyRecord(2),
      ];
      mockApi.getEpochKeys.mockResolvedValue(records);

      const bundles = await fetchAndUnwrapEpochKeys('album-123');

      expect(bundles).toHaveLength(2);
      expect(bundles.map((bundle) => bundle.epochId).sort((a, b) => a - b)).toEqual([
        1, 2,
      ]);
      expect(mockApi.getEpochKeys).toHaveBeenCalledWith('album-123');
    });

    it('caches unwrapped keys as opaque handle ids', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);

      await fetchAndUnwrapEpochKeys('album-123');

      const cached = getEpochKey('album-123', 1);
      expect(cached).not.toBeNull();
      expect(cached?.epochId).toBe(1);
      expect(typeof cached?.epochHandleId).toBe('string');
      expect(cached!.epochHandleId.length).toBeGreaterThan(0);
      expect(() => (cached as unknown as { epochSeed: Uint8Array }).epochSeed)
        .toThrow('epochSeed is removed; use epochHandleId');
      expect(cached?.signKeypair.secretKey.length).toBe(0);
    });

    it('skips already cached keys', async () => {
      setEpochKey('album-123', {
        epochId: 1,
        epochHandleId: 'epch_pre-cached',
        signPublicKey: new Uint8Array(32).fill(2),
      });

      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);

      const bundles = await fetchAndUnwrapEpochKeys('album-123');

      expect(bundles[0]?.epochHandleId).toBe('epch_pre-cached');
      expect(mockCryptoClient.openEpochKeyBundle).not.toHaveBeenCalled();
    });

    it('prefers the newest record when the same epoch is uploaded twice', async () => {
      const olderBundle = new Uint8Array(100).fill(1);
      const newerBundle = new Uint8Array(100).fill(2);

      mockApi.getEpochKeys.mockResolvedValue([
        {
          ...createMockEpochKeyRecord(1),
          encryptedKeyBundle: toBase64(olderBundle),
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          ...createMockEpochKeyRecord(1),
          encryptedKeyBundle: toBase64(newerBundle),
          createdAt: '2024-01-02T00:00:00Z',
        },
      ]);

      mockCryptoClient.openEpochKeyBundle.mockImplementation(
        async (bundle: Uint8Array) => ({
          epochHandleId: `epch_${String(bundle[0])}`,
          epochId: 1,
          signPublicKey: new Uint8Array(32).fill(2),
        }),
      );

      const bundles = await fetchAndUnwrapEpochKeys('album-123');

      expect(bundles).toHaveLength(1);
      expect(bundles[0]?.epochHandleId).toBe('epch_2');
      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenCalledTimes(1);
    });

    it('retries legacy empty-albumId bundles only when compatibility is explicitly enabled', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);
      mockCryptoClient.openEpochKeyBundle
        .mockRejectedValueOnce(new Error('Bundle albumId must not be empty'))
        .mockResolvedValueOnce({
          epochHandleId: 'epch_legacy',
          epochId: 1,
          signPublicKey: new Uint8Array(32).fill(2),
        });

      const bundles = await fetchAndUnwrapEpochKeys('album-123', 0, {
        allowLegacyEmptyAlbumId: true,
      });

      expect(bundles).toHaveLength(1);
      expect(bundles[0]?.epochHandleId).toBe('epch_legacy');
      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenNthCalledWith(
        1,
        expect.any(Uint8Array),
        expect.any(Uint8Array),
        'album-123',
        0,
      );
      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenNthCalledWith(
        2,
        expect.any(Uint8Array),
        expect.any(Uint8Array),
        'album-123',
        0,
        { allowLegacyEmptyAlbumId: true },
      );
    });

    it('rejects legacy empty-albumId bundles by default', async () => {
      mockApi.getEpochKeys.mockResolvedValue([createMockEpochKeyRecord(1)]);
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Bundle albumId must not be empty'),
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        /Bundle albumId must not be empty/,
      );

      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenCalledTimes(1);
      expect(mockCryptoClient.openEpochKeyBundle).not.toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.any(Uint8Array),
        'album-123',
        0,
        { allowLegacyEmptyAlbumId: true },
      );
    });

    it('rejects a malicious legacy duplicate when a strict record exists for the epoch', async () => {
      const newerLegacyBundle = new Uint8Array(100).fill(1);
      const olderStrictBundle = new Uint8Array(100).fill(2);

      mockApi.getEpochKeys.mockResolvedValue([
        {
          ...createMockEpochKeyRecord(1),
          encryptedKeyBundle: toBase64(newerLegacyBundle),
          createdAt: '2024-01-02T00:00:00Z',
        },
        {
          ...createMockEpochKeyRecord(1),
          encryptedKeyBundle: toBase64(olderStrictBundle),
          createdAt: '2024-01-01T00:00:00Z',
        },
      ]);

      mockCryptoClient.openEpochKeyBundle.mockImplementation(
        async (bundle: Uint8Array, _sender, _albumId, _minEpochId, options) => {
          if (bundle[0] === 1 && !options?.allowLegacyEmptyAlbumId) {
            throw new Error('Bundle albumId must not be empty');
          }

          return {
            epochHandleId: `epch_${String(bundle[0])}`,
            epochId: 1,
            signPublicKey: new Uint8Array(32).fill(2),
          };
        },
      );

      const bundles = await fetchAndUnwrapEpochKeys('album-123', 0, {
        allowLegacyEmptyAlbumId: true,
      });

      expect(bundles).toHaveLength(1);
      expect(bundles[0]?.epochHandleId).toBe('epch_2');
      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenCalledTimes(2);
      expect(
        mockCryptoClient.openEpochKeyBundle.mock.calls.every(
          (call) => call[4] === undefined,
        ),
      ).toBe(true);
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
      expect(bundles.map((b) => b.epochId).sort((a, b) => a - b)).toEqual([
        2, 3,
      ]);
    });

    it('throws IDENTITY_NOT_DERIVED when identity not available', async () => {
      mockCryptoClient.getIdentityPublicKey.mockResolvedValue(null);
      mockCryptoClient.deriveIdentity.mockRejectedValue(
        new Error('Not initialized'),
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError,
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.IDENTITY_NOT_DERIVED,
        );
      }
    });

    it('throws FETCH_FAILED when API fails', async () => {
      mockApi.getEpochKeys.mockRejectedValue(new Error('Network error'));

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError,
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.FETCH_FAILED,
        );
      }
    });

    it('throws NO_KEYS_AVAILABLE when server returns empty array', async () => {
      mockApi.getEpochKeys.mockResolvedValue([]);

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError,
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.NO_KEYS_AVAILABLE,
        );
      }
    });

    it('throws SIGNATURE_INVALID on signature error', async () => {
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Invalid signature - not from claimed owner'),
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError,
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.SIGNATURE_INVALID,
        );
      }
    });

    it('throws DECRYPTION_FAILED on decryption error', async () => {
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Failed to decrypt - not intended for this recipient'),
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError,
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.DECRYPTION_FAILED,
        );
      }
    });

    it('throws CONTEXT_MISMATCH on context error', async () => {
      mockCryptoClient.openEpochKeyBundle.mockRejectedValue(
        new Error('Bundle albumId mismatch: expected X, got Y'),
      );

      await expect(fetchAndUnwrapEpochKeys('album-123')).rejects.toThrow(
        EpochKeyError,
      );

      try {
        await fetchAndUnwrapEpochKeys('album-123');
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.CONTEXT_MISMATCH,
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
        epochHandleId: 'epch_cached-5',
        signPublicKey: new Uint8Array(32),
      });

      const bundle = await getOrFetchEpochKey('album-123', 5);

      expect(bundle.epochId).toBe(5);
      expect(bundle.epochHandleId).toBe('epch_cached-5');
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
        EpochKeyError,
      );

      try {
        await getOrFetchEpochKey('album-123', 999);
      } catch (err) {
        expect(err).toBeInstanceOf(EpochKeyError);
        expect((err as EpochKeyError).code).toBe(
          EpochKeyErrorCode.NO_KEYS_AVAILABLE,
        );
      }
    });
  });

  describe('getCurrentOrFetchEpochKey', () => {
    it('returns cached current key without fetching', async () => {
      setEpochKey('album-123', {
        epochId: 10,
        epochHandleId: 'epch_10',
        signPublicKey: new Uint8Array(32),
      });
      setEpochKey('album-123', {
        epochId: 5,
        epochHandleId: 'epch_5',
        signPublicKey: new Uint8Array(32),
      });

      const bundle = await getCurrentOrFetchEpochKey('album-123');

      expect(bundle.epochId).toBe(10);
      expect(mockApi.getEpochKeys).not.toHaveBeenCalled();
    });

    it('fetches and returns current key when not cached', async () => {
      const records = [
        createMockEpochKeyRecord(1),
        createMockEpochKeyRecord(5),
        createMockEpochKeyRecord(3),
      ];
      mockApi.getEpochKeys.mockResolvedValue(records);

      const bundle = await getCurrentOrFetchEpochKey('album-123');

      // Should return highest epoch (5)
      expect(bundle.epochId).toBe(5);
    });
  });

  describe('ensureEpochKeysLoaded', () => {
    it('returns true immediately if keys are cached', async () => {
      setEpochKey('album-123', {
        epochId: 1,
        epochHandleId: 'epch_1',
        signPublicKey: new Uint8Array(32),
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
      const signature = new Uint8Array(64).fill(0xaa);
      const sealedBox = new Uint8Array(50).fill(0xbb);
      const fullBundle = new Uint8Array([...signature, ...sealedBox]);

      const record: EpochKeyRecord = {
        id: 'key-1',
        albumId: 'album-regression',
        epochId: 1,
        encryptedKeyBundle: toBase64(fullBundle),
        ownerSignature: toBase64(signature),
        sharerPubkey: toBase64(new Uint8Array(32).fill(0xcc)),
        signPubkey: toBase64(new Uint8Array(32)),
        createdAt: new Date().toISOString(),
      };

      mockApi.getEpochKeys.mockResolvedValue([record]);

      await fetchAndUnwrapEpochKeys('album-regression');

      expect(mockCryptoClient.openEpochKeyBundle).toHaveBeenCalledTimes(1);
      const calledBundle = mockCryptoClient.openEpochKeyBundle.mock
        .calls[0][0] as Uint8Array;

      expect(calledBundle.length).toBe(fullBundle.length);
      expect(calledBundle).toEqual(fullBundle);
      expect(calledBundle.slice(0, 64)).toEqual(signature);
      expect(calledBundle.slice(64)).toEqual(sealedBox);
    });
  });
});
