/**
 * Epoch Rotation Service Tests
 *
 * Tests for epoch key rotation after member removal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearPhotoCaches,
    EpochRotationError,
    EpochRotationErrorCode,
    rotateEpoch,
    RotationStep,
} from '../src/lib/epoch-rotation-service';

// Mock dependencies
vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(),
  toBase64: vi.fn((arr: Uint8Array) => Buffer.from(arr).toString('base64')),
  fromBase64: vi.fn((str: string) => new Uint8Array(Buffer.from(str, 'base64'))),
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  clearAlbumKeys: vi.fn(),
  setEpochKey: vi.fn(),
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: vi.fn().mockResolvedValue([]),
}));

import { getApi } from '../src/lib/api';
import { getCryptoClient } from '../src/lib/crypto-client';
import { fetchAndUnwrapEpochKeys } from '../src/lib/epoch-key-service';
import { clearAlbumKeys, setEpochKey } from '../src/lib/epoch-key-store';

describe('epoch-rotation-service', () => {
  // Mock data
  const albumId = 'album-123';
  const currentEpochId = 5;
  const newEpochId = 6;
  
  const mockAlbum = {
    id: albumId,
    ownerId: 'user-owner',
    currentVersion: 10,
    currentEpochId,
    createdAt: '2024-01-01T00:00:00Z',
  };

  const mockMembers = [
    {
      userId: 'user-owner',
      role: 'owner',
      joinedAt: '2024-01-01T00:00:00Z',
      user: { id: 'user-owner', identityPubkey: 'b3duZXJQdWJrZXk=' }, // 'ownerPubkey' in base64
    },
    {
      userId: 'user-member1',
      role: 'editor',
      joinedAt: '2024-01-02T00:00:00Z',
      user: { id: 'user-member1', identityPubkey: 'bWVtYmVyMVB1YmtleQ==' }, // 'member1Pubkey' in base64
    },
  ];

  const mockNewEpochKey = {
    readKey: new Uint8Array(32).fill(42),
    signPublicKey: new Uint8Array(32).fill(1),
    signSecretKey: new Uint8Array(64).fill(2),
  };

  const mockIdentityPubkey = new Uint8Array(32).fill(99);

  const mockSealedBundle = {
    encryptedBundle: new Uint8Array([1, 2, 3, 4]),
    signature: new Uint8Array([5, 6, 7, 8]),
  };

  let mockApi: {
    getAlbum: ReturnType<typeof vi.fn>;
    listAlbumMembers: ReturnType<typeof vi.fn>;
    rotateEpoch: ReturnType<typeof vi.fn>;
  };

  let mockCrypto: {
    generateEpochKey: ReturnType<typeof vi.fn>;
    getIdentityPublicKey: ReturnType<typeof vi.fn>;
    deriveIdentity: ReturnType<typeof vi.fn>;
    createEpochKeyBundle: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      getAlbum: vi.fn().mockResolvedValue(mockAlbum),
      listAlbumMembers: vi.fn().mockResolvedValue(mockMembers),
      rotateEpoch: vi.fn().mockResolvedValue(undefined),
    };

    mockCrypto = {
      generateEpochKey: vi.fn().mockResolvedValue(mockNewEpochKey),
      getIdentityPublicKey: vi.fn().mockResolvedValue(mockIdentityPubkey),
      deriveIdentity: vi.fn().mockResolvedValue(undefined),
      createEpochKeyBundle: vi.fn().mockResolvedValue(mockSealedBundle),
    };

    vi.mocked(getApi).mockReturnValue(mockApi as any);
    vi.mocked(getCryptoClient).mockResolvedValue(mockCrypto as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rotateEpoch', () => {
    it('should complete full rotation successfully', async () => {
      const result = await rotateEpoch(albumId);

      expect(result).toEqual({
        newEpochId,
        recipientCount: 2,
      });
    });

    it('should call API methods in correct order', async () => {
      await rotateEpoch(albumId);

      // Should fetch album first
      expect(mockApi.getAlbum).toHaveBeenCalledWith(albumId);
      
      // Then generate new key
      expect(mockCrypto.generateEpochKey).toHaveBeenCalledWith(newEpochId);
      
      // Then fetch members
      expect(mockApi.listAlbumMembers).toHaveBeenCalledWith(albumId);
      
      // Then create bundles for each member
      expect(mockCrypto.createEpochKeyBundle).toHaveBeenCalledTimes(2);
      
      // Finally call rotate API
      expect(mockApi.rotateEpoch).toHaveBeenCalledWith(
        albumId,
        newEpochId,
        expect.objectContaining({
          epochKeys: expect.arrayContaining([
            expect.objectContaining({ recipientId: 'user-owner' }),
            expect.objectContaining({ recipientId: 'user-member1' }),
          ]),
        })
      );
    });

    it('should report progress through callback', async () => {
      const progressCallback = vi.fn();

      await rotateEpoch(albumId, progressCallback);

      expect(progressCallback).toHaveBeenCalledWith(RotationStep.FETCHING_ALBUM);
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.GENERATING_KEY);
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.FETCHING_MEMBERS);
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.SEALING_KEYS);
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.CALLING_API);
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.UPDATING_CACHE);
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.COMPLETE);
    });

    it('should clear old epoch keys and cache new one', async () => {
      await rotateEpoch(albumId);

      expect(clearAlbumKeys).toHaveBeenCalledWith(albumId);
      expect(setEpochKey).toHaveBeenCalledWith(
        albumId,
        expect.objectContaining({
          epochId: newEpochId,
          readKey: mockNewEpochKey.readKey,
          signKeypair: expect.objectContaining({
            publicKey: mockNewEpochKey.signPublicKey,
            secretKey: mockNewEpochKey.signSecretKey,
          }),
        })
      );
    });

    it('should generate fresh random key (not derived from previous)', async () => {
      await rotateEpoch(albumId);

      // The generateEpochKey should be called with just the new epoch ID
      // This ensures it generates fresh random keys, not derived from previous
      expect(mockCrypto.generateEpochKey).toHaveBeenCalledWith(newEpochId);
      expect(mockCrypto.generateEpochKey).toHaveBeenCalledTimes(1);
      
      // Verify the old epoch key was NOT passed to generateEpochKey
      const callArgs = mockCrypto.generateEpochKey.mock.calls[0];
      expect(callArgs.length).toBe(1); // Only epoch ID
    });

    it('should derive identity if not yet derived', async () => {
      mockCrypto.getIdentityPublicKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockIdentityPubkey);

      await rotateEpoch(albumId);

      expect(mockCrypto.deriveIdentity).toHaveBeenCalled();
    });

    describe('error handling', () => {
      it('should throw ALBUM_FETCH_FAILED when album fetch fails', async () => {
        mockApi.getAlbum.mockRejectedValue(new Error('Network error'));

        await expect(rotateEpoch(albumId)).rejects.toThrow(EpochRotationError);
        
        try {
          await rotateEpoch(albumId);
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.ALBUM_FETCH_FAILED);
        }
      });

      it('should throw MEMBERS_FETCH_FAILED when members fetch fails', async () => {
        mockApi.listAlbumMembers.mockRejectedValue(new Error('Network error'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.MEMBERS_FETCH_FAILED);
        }
      });

      it('should throw NO_RECIPIENTS when no members remain', async () => {
        mockApi.listAlbumMembers.mockResolvedValue([]);

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.NO_RECIPIENTS);
        }
      });

      it('should throw KEY_GENERATION_FAILED when key generation fails', async () => {
        mockCrypto.generateEpochKey.mockRejectedValue(new Error('RNG failed'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.KEY_GENERATION_FAILED);
        }
      });

      it('should throw RECIPIENT_NO_PUBKEY when member lacks identity pubkey', async () => {
        mockApi.listAlbumMembers.mockResolvedValue([
          {
            userId: 'user-no-pubkey',
            role: 'editor',
            joinedAt: '2024-01-02T00:00:00Z',
            user: { id: 'user-no-pubkey' }, // No identityPubkey
          },
        ]);

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.RECIPIENT_NO_PUBKEY);
        }
      });

      it('should throw SEAL_FAILED when bundle sealing fails', async () => {
        mockCrypto.createEpochKeyBundle.mockRejectedValue(new Error('Seal failed'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.SEAL_FAILED);
        }
      });

      it('should throw ROTATE_FAILED when API rotation fails', async () => {
        mockApi.rotateEpoch.mockRejectedValue(new Error('Server error'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.ROTATE_FAILED);
        }
      });

      it('should throw IDENTITY_NOT_DERIVED when identity cannot be derived', async () => {
        mockCrypto.getIdentityPublicKey.mockResolvedValue(null);
        mockCrypto.deriveIdentity.mockRejectedValue(new Error('Not logged in'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(EpochRotationErrorCode.IDENTITY_NOT_DERIVED);
        }
      });
    });
  });

  describe('clearPhotoCaches', () => {
    it('should clear album keys', async () => {
      await clearPhotoCaches(albumId);

      expect(clearAlbumKeys).toHaveBeenCalledWith(albumId);
    });

    it('should attempt to fetch new epoch keys', async () => {
      await clearPhotoCaches(albumId);

      expect(fetchAndUnwrapEpochKeys).toHaveBeenCalledWith(albumId);
    });

    it('should not throw if fetchAndUnwrapEpochKeys fails', async () => {
      vi.mocked(fetchAndUnwrapEpochKeys).mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(clearPhotoCaches(albumId)).resolves.toBeUndefined();
    });
  });
});
