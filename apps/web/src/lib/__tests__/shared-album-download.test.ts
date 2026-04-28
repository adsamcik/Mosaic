import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../../workers/types';

const mocks = vi.hoisted(() => ({
  downloadShardViaShareLink: vi.fn(),
  decryptShardWithTierKey: vi.fn(),
  peekHeader: vi.fn(),
  verifyShard: vi.fn(),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      decryptShardWithTierKey: mocks.decryptShardWithTierKey,
      peekHeader: mocks.peekHeader,
      verifyShard: mocks.verifyShard,
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
    mocks.verifyShard.mockResolvedValue(true);
  });

  it('downloads, verifies, decrypts, and concatenates explicit original shards', async () => {
    const tierKey = new Uint8Array(32).fill(3);
    const encryptedA = new Uint8Array([10]);
    const encryptedB = new Uint8Array([20]);
    const chunkA = new Uint8Array([1, 2]);
    const chunkB = new Uint8Array([3, 4, 5]);
    mocks.downloadShardViaShareLink
      .mockResolvedValueOnce(encryptedA)
      .mockResolvedValueOnce(encryptedB);
    mocks.decryptShardWithTierKey
      .mockResolvedValueOnce(chunkA)
      .mockResolvedValueOnce(chunkB);

    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      grantToken: 'grant-token',
      getTierKey: (epochId, tier) =>
        epochId === 7 && tier === 3 ? tierKey : undefined,
    });

    const result = await resolver(
      createPhoto({
        originalShardIds: ['original-a', 'original-b'],
        originalShardHashes: ['hash-a', 'hash-b'],
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
    expect(mocks.verifyShard).toHaveBeenNthCalledWith(
      1,
      encryptedA,
      'hash-a',
    );
    expect(mocks.verifyShard).toHaveBeenNthCalledWith(
      2,
      encryptedB,
      'hash-b',
    );
    expect(mocks.decryptShardWithTierKey).toHaveBeenNthCalledWith(
      1,
      encryptedA,
      tierKey,
    );
    expect(mocks.decryptShardWithTierKey).toHaveBeenNthCalledWith(
      2,
      encryptedB,
      tierKey,
    );
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('falls back to legacy shardIds by selecting only tier-3 shards', async () => {
    const tierKey = new Uint8Array(32).fill(3);
    const encryptedThumb = new Uint8Array([1]);
    const encryptedOriginalA = new Uint8Array([2]);
    const encryptedOriginalB = new Uint8Array([3]);
    mocks.downloadShardViaShareLink
      .mockResolvedValueOnce(encryptedThumb)
      .mockResolvedValueOnce(encryptedOriginalA)
      .mockResolvedValueOnce(encryptedOriginalB);
    mocks.peekHeader
      .mockResolvedValueOnce({ epochId: 7, shardId: 1, tier: 1 })
      .mockResolvedValueOnce({ epochId: 7, shardId: 2, tier: 3 })
      .mockResolvedValueOnce({ epochId: 7, shardId: 3, tier: 3 });
    mocks.decryptShardWithTierKey
      .mockResolvedValueOnce(new Uint8Array([8]))
      .mockResolvedValueOnce(new Uint8Array([9]));

    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      getTierKey: (epochId, tier) =>
        epochId === 7 && tier === 3 ? tierKey : undefined,
    });

    const result = await resolver(
      createPhoto({
        originalShardIds: [],
        shardIds: ['thumb', 'original-a', 'original-b'],
        shardHashes: ['hash-thumb', 'hash-a', 'hash-b'],
      }),
    );

    expect(mocks.downloadShardViaShareLink).toHaveBeenCalledTimes(3);
    expect(mocks.verifyShard).toHaveBeenCalledTimes(3);
    expect(mocks.decryptShardWithTierKey).toHaveBeenNthCalledWith(
      1,
      encryptedOriginalA,
      tierKey,
    );
    expect(mocks.decryptShardWithTierKey).toHaveBeenNthCalledWith(
      2,
      encryptedOriginalB,
      tierKey,
    );
    expect(result).toEqual(new Uint8Array([8, 9]));
  });

  it('fails before downloading explicit originals when the tier-3 key is missing', async () => {
    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      getTierKey: () => undefined,
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
    mocks.peekHeader.mockResolvedValueOnce({ epochId: 7, shardId: 1, tier: 2 });

    const resolver = createShareLinkOriginalResolver({
      linkId: 'share-link',
      getTierKey: () => new Uint8Array(32).fill(3),
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
