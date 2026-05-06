import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../../workers/types';

const mocks = vi.hoisted(() => ({
  downloadShardViaShareLink: vi.fn(),
  decryptShardWithTierKey: vi.fn(),
  decryptShardWithLinkTierHandle: vi.fn(),
  peekEnvelopeHeader: vi.fn(),
  verifyShardIntegrity: vi.fn(),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      decryptShardWithTierKey: mocks.decryptShardWithTierKey,
      decryptShardWithLinkTierHandle: mocks.decryptShardWithLinkTierHandle,
      peekEnvelopeHeader: mocks.peekEnvelopeHeader,
      verifyShardIntegrity: mocks.verifyShardIntegrity,
    }),
  ),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../shard-service', () => ({
  downloadShardViaShareLink: mocks.downloadShardViaShareLink,
}));

import { createShareLinkOriginalResolver } from '../shared-album-download';

function createPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    shardIds: ['thumb-1', 'preview-1', 'original-1'],
    epochId: 7,
    ...overrides,
  };
}

describe('createShareLinkOriginalResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyShardIntegrity.mockResolvedValue(true);
  });

  it('downloads, verifies, decrypts, and concatenates explicit original shards', async () => {
    const tierKey = 'link-tier-handle-3' as never;
    const encryptedA = new Uint8Array([10]);
    const encryptedB = new Uint8Array([20]);
    const chunkA = new Uint8Array([1, 2]);
    const chunkB = new Uint8Array([3, 4, 5]);
    mocks.downloadShardViaShareLink
      .mockResolvedValueOnce(encryptedA)
      .mockResolvedValueOnce(encryptedB);
    mocks.decryptShardWithLinkTierHandle
      .mockResolvedValueOnce(chunkA)
      .mockResolvedValueOnce(chunkB);

    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      grantToken: 'grant-token',
      getTierKeyHandle: (epochId, tier) =>
        epochId === 7 && tier === 3 ? tierKey : undefined,
    });

    const result = await resolver(
      createPhoto({
        originalShardIds: ['original-a', 'original-b'],
        originalShardHashes: ['A'.repeat(43), 'A'.repeat(43)],
      }),
    );

    expect(mocks.downloadShardViaShareLink).toHaveBeenNthCalledWith(
      1,
      'share-link',
      'original-a',
      'grant-token',
    );
    expect(mocks.downloadShardViaShareLink).toHaveBeenNthCalledWith(
      2,
      'share-link',
      'original-b',
      'grant-token',
    );
    expect(mocks.verifyShardIntegrity).toHaveBeenNthCalledWith(
      1,
      encryptedA,
      new Uint8Array(32),
    );
    expect(mocks.verifyShardIntegrity).toHaveBeenNthCalledWith(
      2,
      encryptedB,
      new Uint8Array(32),
    );
    expect(mocks.decryptShardWithLinkTierHandle).toHaveBeenNthCalledWith(
      1,
      tierKey,
      encryptedA,
    );
    expect(mocks.decryptShardWithLinkTierHandle).toHaveBeenNthCalledWith(
      2,
      tierKey,
      encryptedB,
    );
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('falls back to legacy shardIds by selecting only tier-3 shards', async () => {
    const tierKey = 'link-tier-handle-3' as never;
    const encryptedThumb = new Uint8Array([1]);
    const encryptedOriginalA = new Uint8Array([2]);
    const encryptedOriginalB = new Uint8Array([3]);
    mocks.downloadShardViaShareLink
      .mockResolvedValueOnce(encryptedThumb)
      .mockResolvedValueOnce(encryptedOriginalA)
      .mockResolvedValueOnce(encryptedOriginalB);
    mocks.peekEnvelopeHeader
      .mockResolvedValueOnce({ version: 0x03, magic: 'SGzk', epoch: 7, shard: 1, tier: 1, nonce: new Uint8Array(24) })
      .mockResolvedValueOnce({ version: 0x03, magic: 'SGzk', epoch: 7, shard: 2, tier: 3, nonce: new Uint8Array(24) })
      .mockResolvedValueOnce({ version: 0x03, magic: 'SGzk', epoch: 7, shard: 3, tier: 3, nonce: new Uint8Array(24) });
    mocks.decryptShardWithLinkTierHandle
      .mockResolvedValueOnce(new Uint8Array([8]))
      .mockResolvedValueOnce(new Uint8Array([9]));

    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      getTierKeyHandle: (epochId, tier) =>
        epochId === 7 && tier === 3 ? tierKey : undefined,
    });

    const result = await resolver(
      createPhoto({
        originalShardIds: [],
        shardIds: ['thumb', 'original-a', 'original-b'],
        shardHashes: ['A'.repeat(43), 'A'.repeat(43), 'A'.repeat(43)],
      }),
    );

    expect(mocks.downloadShardViaShareLink).toHaveBeenCalledTimes(3);
    expect(mocks.verifyShardIntegrity).toHaveBeenCalledTimes(3);
    expect(mocks.decryptShardWithLinkTierHandle).toHaveBeenNthCalledWith(
      1,
      tierKey,
      encryptedOriginalA,
    );
    expect(mocks.decryptShardWithLinkTierHandle).toHaveBeenNthCalledWith(
      2,
      tierKey,
      encryptedOriginalB,
    );
    expect(result).toEqual(new Uint8Array([8, 9]));
  });

  it('fails before downloading explicit originals when the tier-3 key is missing', async () => {
    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      getTierKeyHandle: () => undefined,
    });

    await expect(
      resolver(
        createPhoto({
          originalShardIds: ['original-a'],
        }),
      ),
    ).rejects.toThrow('No tier 3 decryption key available for epoch 7');
    expect(mocks.downloadShardViaShareLink).not.toHaveBeenCalled();
  });

  it('fails legacy downloads when no tier-3 shards are available', async () => {
    mocks.downloadShardViaShareLink.mockResolvedValueOnce(new Uint8Array([1]));
    mocks.peekEnvelopeHeader.mockResolvedValueOnce({ version: 0x03, magic: 'SGzk', epoch: 7, shard: 1, tier: 2, nonce: new Uint8Array(24) });

    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      getTierKeyHandle: () => 'link-tier-handle-3' as never,
    });

    await expect(
      resolver(
        createPhoto({
          originalShardIds: [],
          shardIds: ['preview-only'],
        }),
      ),
    ).rejects.toThrow('No original-tier shards available for photo photo-1');
  });
});
