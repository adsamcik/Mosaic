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
  fromBase64: vi.fn(
    (str: string) => new Uint8Array(Buffer.from(str, 'base64')),
  ),
  paginateAll: async <T>(
    fetchPage: (skip: number, take: number) => Promise<T[]>,
    pageSize = 100,
  ): Promise<T[]> => {
    const out: T[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const page = await fetchPage(skip, pageSize);
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  },
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

// Mock @mosaic/crypto for tier key derivation
vi.mock('@mosaic/crypto', () => ({
  deriveTierKeys: vi.fn(() => ({
    thumbKey: new Uint8Array(32).fill(10),
    previewKey: new Uint8Array(32).fill(11),
    fullKey: new Uint8Array(32).fill(12),
  })),
  deriveLinkKeys: vi.fn(() => ({
    linkId: new Uint8Array(16).fill(1),
    wrappingKey: new Uint8Array(32).fill(20),
  })),
  wrapTierKeyForLink: vi.fn((tierKey, tier) => ({
    tier,
    nonce: new Uint8Array(24).fill(tier),
    encryptedKey: new Uint8Array(48).fill(tier),
  })),
  AccessTier: { THUMB: 1, PREVIEW: 2, FULL: 3 },
  // memzero is dynamic-imported by wrapKeysForShareLinks to wipe tier keys
  // and per-iteration linkSecret/wrappingKey buffers (security fix M1).
  memzero: vi.fn((buf: Uint8Array) => {
    buf.fill(0);
  }),
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
    epochSeed: new Uint8Array(32).fill(42),
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
    listShareLinksWithSecrets: ReturnType<typeof vi.fn>;
    rotateEpoch: ReturnType<typeof vi.fn>;
  };

  let mockCrypto: {
    generateEpochKey: ReturnType<typeof vi.fn>;
    getIdentityPublicKey: ReturnType<typeof vi.fn>;
    deriveIdentity: ReturnType<typeof vi.fn>;
    createEpochKeyBundle: ReturnType<typeof vi.fn>;
    unwrapWithAccountKey: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      getAlbum: vi.fn().mockResolvedValue(mockAlbum),
      listAlbumMembers: vi.fn().mockResolvedValue(mockMembers),
      listShareLinksWithSecrets: vi.fn().mockResolvedValue([]),
      rotateEpoch: vi.fn().mockResolvedValue(undefined),
    };

    mockCrypto = {
      generateEpochKey: vi.fn().mockResolvedValue(mockNewEpochKey),
      getIdentityPublicKey: vi.fn().mockResolvedValue(mockIdentityPubkey),
      deriveIdentity: vi.fn().mockResolvedValue(undefined),
      createEpochKeyBundle: vi.fn().mockResolvedValue(mockSealedBundle),
      unwrapWithAccountKey: vi
        .fn()
        .mockResolvedValue(new Uint8Array(32).fill(50)),
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
        shareLinkCount: 0,
      });
    });

    it('seals the new key for every member when the membership spans multiple pages', async () => {
      // Regression: previously `listAlbumMembers` was called once with the
      // backend default cap (50). Albums with >50 members silently lost
      // access to the new epoch key. Simulate a 120-member album returned
      // across two full pages of 100 + a tail page of 20 and verify every
      // member receives a sealed bundle.
      const makeMember = (i: number) => ({
        userId: `user-${i}`,
        role: i === 0 ? 'owner' : 'editor',
        joinedAt: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        user: {
          id: `user-${i}`,
          identityPubkey: Buffer.from(`pubkey-${i}`).toString('base64'),
        },
      });
      const allMembers = Array.from({ length: 120 }, (_, i) => makeMember(i));

      mockApi.listAlbumMembers.mockImplementation(
        async (_albumId: string, skip: number, take: number) =>
          allMembers.slice(skip, skip + take),
      );

      const result = await rotateEpoch(albumId);

      expect(result.recipientCount).toBe(120);
      // One sealed bundle per member — proves no member was silently dropped.
      expect(mockCrypto.createEpochKeyBundle).toHaveBeenCalledTimes(120);
      // Pagination should have happened across multiple pages.
      expect(mockApi.listAlbumMembers.mock.calls.length).toBeGreaterThanOrEqual(2);

      // The recipientId list passed to the rotate API must match every member.
      const rotateCall = mockApi.rotateEpoch.mock.calls[0]?.[2] as
        | { epochKeys: { recipientId: string }[] }
        | undefined;
      const recipientIds = rotateCall?.epochKeys.map((k) => k.recipientId) ?? [];
      expect(new Set(recipientIds)).toEqual(
        new Set(allMembers.map((m) => m.userId)),
      );
    });

    it('should call API methods in correct order', async () => {
      await rotateEpoch(albumId);

      // Should fetch album first
      expect(mockApi.getAlbum).toHaveBeenCalledWith(albumId);

      // Then generate new key
      expect(mockCrypto.generateEpochKey).toHaveBeenCalledWith(newEpochId);

      // Then fetch members (paginated)
      expect(mockApi.listAlbumMembers).toHaveBeenCalledWith(
        albumId,
        expect.any(Number),
        expect.any(Number),
      );

      // Then fetch share links (paginated)
      expect(mockApi.listShareLinksWithSecrets).toHaveBeenCalledWith(
        albumId,
        expect.any(Number),
        expect.any(Number),
      );

      // Then fetch members (paginated)
      expect(mockApi.listAlbumMembers).toHaveBeenCalledWith(
        albumId,
        expect.any(Number),
        expect.any(Number),
      );

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
        }),
      );
    });

    it('should report progress through callback', async () => {
      const progressCallback = vi.fn();

      await rotateEpoch(albumId, progressCallback);

      expect(progressCallback).toHaveBeenCalledWith(
        RotationStep.FETCHING_ALBUM,
      );
      expect(progressCallback).toHaveBeenCalledWith(
        RotationStep.GENERATING_KEY,
      );
      expect(progressCallback).toHaveBeenCalledWith(
        RotationStep.FETCHING_MEMBERS,
      );
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.SEALING_KEYS);
      expect(progressCallback).toHaveBeenCalledWith(
        RotationStep.FETCHING_SHARE_LINKS,
      );
      expect(progressCallback).toHaveBeenCalledWith(
        RotationStep.WRAPPING_SHARE_LINK_KEYS,
      );
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.CALLING_API);
      expect(progressCallback).toHaveBeenCalledWith(
        RotationStep.UPDATING_CACHE,
      );
      expect(progressCallback).toHaveBeenCalledWith(RotationStep.COMPLETE);
    });

    it('should clear old epoch keys and cache new one', async () => {
      await rotateEpoch(albumId);

      expect(clearAlbumKeys).toHaveBeenCalledWith(albumId);
      expect(setEpochKey).toHaveBeenCalledWith(
        albumId,
        expect.objectContaining({
          epochId: newEpochId,
          epochSeed: mockNewEpochKey.epochSeed,
          signKeypair: expect.objectContaining({
            publicKey: mockNewEpochKey.signPublicKey,
            secretKey: mockNewEpochKey.signSecretKey,
          }),
        }),
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
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.ALBUM_FETCH_FAILED,
          );
        }
      });

      it('should throw MEMBERS_FETCH_FAILED when members fetch fails', async () => {
        mockApi.listAlbumMembers.mockRejectedValue(new Error('Network error'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.MEMBERS_FETCH_FAILED,
          );
        }
      });

      it('should throw NO_RECIPIENTS when no members remain', async () => {
        mockApi.listAlbumMembers.mockResolvedValue([]);

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.NO_RECIPIENTS,
          );
        }
      });

      it('should throw KEY_GENERATION_FAILED when key generation fails', async () => {
        mockCrypto.generateEpochKey.mockRejectedValue(new Error('RNG failed'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.KEY_GENERATION_FAILED,
          );
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
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.RECIPIENT_NO_PUBKEY,
          );
        }
      });

      it('should throw SEAL_FAILED when bundle sealing fails', async () => {
        mockCrypto.createEpochKeyBundle.mockRejectedValue(
          new Error('Seal failed'),
        );

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.SEAL_FAILED,
          );
        }
      });

      it('should throw ROTATE_FAILED when API rotation fails', async () => {
        mockApi.rotateEpoch.mockRejectedValue(new Error('Server error'));

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.ROTATE_FAILED,
          );
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
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.IDENTITY_NOT_DERIVED,
          );
        }
      });

      it('should throw SHARE_LINKS_FETCH_FAILED when share links fetch fails', async () => {
        mockApi.listShareLinksWithSecrets.mockRejectedValue(
          new Error('Network error'),
        );

        try {
          await rotateEpoch(albumId);
          expect.fail('Should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(EpochRotationError);
          expect((err as EpochRotationError).code).toBe(
            EpochRotationErrorCode.SHARE_LINKS_FETCH_FAILED,
          );
        }
      });
    });

    describe('share link handling', () => {
      const mockShareLinks = [
        {
          id: 'link-1',
          linkId: 'bGlua0lkMQ==', // base64 encoded
          accessTier: 3, // FULL
          isRevoked: false,
          ownerEncryptedSecret: 'ZW5jcnlwdGVkU2VjcmV0', // base64 encoded
        },
        {
          id: 'link-2',
          linkId: 'bGlua0lkMg==',
          accessTier: 2, // PREVIEW
          isRevoked: false,
          ownerEncryptedSecret: 'ZW5jcnlwdGVkU2VjcmV0Mg==',
        },
      ];

      it('should wrap tier keys for active share links', async () => {
        mockApi.listShareLinksWithSecrets.mockResolvedValue(mockShareLinks);

        const result = await rotateEpoch(albumId);

        expect(result.shareLinkCount).toBe(2);
        expect(mockCrypto.unwrapWithAccountKey).toHaveBeenCalledTimes(2);
      });

      it('should include shareLinkKeys in rotate request', async () => {
        mockApi.listShareLinksWithSecrets.mockResolvedValue(mockShareLinks);

        await rotateEpoch(albumId);

        expect(mockApi.rotateEpoch).toHaveBeenCalledWith(
          albumId,
          newEpochId,
          expect.objectContaining({
            epochKeys: expect.any(Array),
            shareLinkKeys: expect.arrayContaining([
              expect.objectContaining({ shareLinkId: 'link-1' }),
              expect.objectContaining({ shareLinkId: 'link-2' }),
            ]),
          }),
        );
      });

      it('should page through all active share links for epoch rotation', async () => {
        const pagedLinks = Array.from({ length: 150 }, (_, i) => ({
          ...mockShareLinks[i % mockShareLinks.length],
          id: `link-${i}`,
          linkId: Buffer.from(`linkId-${i}`).toString('base64'),
          ownerEncryptedSecret: Buffer.from(`secret-${i}`).toString('base64'),
        }));
        mockApi.listShareLinksWithSecrets.mockImplementation(
          (_albumId: string, skip = 0, take = 100) =>
            Promise.resolve(pagedLinks.slice(skip, skip + take)),
        );

        const result = await rotateEpoch(albumId);

        expect(result.shareLinkCount).toBe(150);
        expect(mockApi.listShareLinksWithSecrets).toHaveBeenNthCalledWith(
          1,
          albumId,
          0,
          100,
        );
        expect(mockApi.listShareLinksWithSecrets).toHaveBeenNthCalledWith(
          2,
          albumId,
          100,
          100,
        );
        expect(mockApi.rotateEpoch).toHaveBeenCalledWith(
          albumId,
          newEpochId,
          expect.objectContaining({
            shareLinkKeys: expect.arrayContaining([
              expect.objectContaining({ shareLinkId: 'link-0' }),
              expect.objectContaining({ shareLinkId: 'link-149' }),
            ]),
          }),
        );
      });

      it('should skip revoked share links', async () => {
        const linksWithRevoked = [
          { ...mockShareLinks[0], isRevoked: true },
          mockShareLinks[1],
        ];
        mockApi.listShareLinksWithSecrets.mockResolvedValue(linksWithRevoked);

        const result = await rotateEpoch(albumId);

        expect(result.shareLinkCount).toBe(1);
        expect(mockCrypto.unwrapWithAccountKey).toHaveBeenCalledTimes(1);
      });

      it('should skip share links without ownerEncryptedSecret', async () => {
        const linksWithoutSecret = [
          { ...mockShareLinks[0], ownerEncryptedSecret: undefined },
          mockShareLinks[1],
        ];
        mockApi.listShareLinksWithSecrets.mockResolvedValue(linksWithoutSecret);

        const result = await rotateEpoch(albumId);

        expect(result.shareLinkCount).toBe(1);
      });

      it('should wrap correct tier keys based on accessTier', async () => {
        mockApi.listShareLinksWithSecrets.mockResolvedValue(mockShareLinks);

        await rotateEpoch(albumId);

        const rotateCall = mockApi.rotateEpoch.mock.calls[0];
        const shareLinkKeys = rotateCall[2].shareLinkKeys;

        // First link has accessTier 3 (FULL) - should have 3 wrapped keys
        const link1Keys = shareLinkKeys.find(
          (k: { shareLinkId: string }) => k.shareLinkId === 'link-1',
        );
        expect(link1Keys.wrappedKeys).toHaveLength(3);

        // Second link has accessTier 2 (PREVIEW) - should have 2 wrapped keys
        const link2Keys = shareLinkKeys.find(
          (k: { shareLinkId: string }) => k.shareLinkId === 'link-2',
        );
        expect(link2Keys.wrappedKeys).toHaveLength(2);
      });

      it('should continue rotation if individual share link wrap fails', async () => {
        mockApi.listShareLinksWithSecrets.mockResolvedValue(mockShareLinks);
        mockCrypto.unwrapWithAccountKey
          .mockResolvedValueOnce(new Uint8Array(32).fill(50)) // First succeeds
          .mockRejectedValueOnce(new Error('Unwrap failed')); // Second fails

        // Should not throw
        const result = await rotateEpoch(albumId);

        // Only one link should be processed successfully
        expect(result.shareLinkCount).toBe(1);
      });

      it('should not include shareLinkKeys when no active links exist', async () => {
        mockApi.listShareLinksWithSecrets.mockResolvedValue([]);

        await rotateEpoch(albumId);

        const rotateCall = mockApi.rotateEpoch.mock.calls[0];
        expect(rotateCall[2].shareLinkKeys).toBeUndefined();
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
      vi.mocked(fetchAndUnwrapEpochKeys).mockRejectedValue(
        new Error('Network error'),
      );

      // Should not throw
      await expect(clearPhotoCaches(albumId)).resolves.toBeUndefined();
    });
  });
});
