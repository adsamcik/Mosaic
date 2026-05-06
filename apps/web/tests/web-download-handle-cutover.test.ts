import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

const mocks = vi.hoisted(() => ({
  downloadZip: vi.fn(),
  getCryptoClient: vi.fn(),
  getOrFetchEpochKey: vi.fn(),
  downloadShards: vi.fn(),
  downloadShardViaShareLink: vi.fn(),
  createDisplayableUrl: vi.fn(),
}));

vi.mock('client-zip', () => ({
  downloadZip: mocks.downloadZip,
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: mocks.getCryptoClient,
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  getOrFetchEpochKey: mocks.getOrFetchEpochKey,
}));

vi.mock('../src/lib/shard-service', () => ({
  downloadShards: mocks.downloadShards,
  downloadShardViaShareLink: mocks.downloadShardViaShareLink,
}));

vi.mock('../src/lib/image-decoder', () => ({
  createDisplayableUrl: mocks.createDisplayableUrl,
}));

vi.mock('../src/lib/thumbnail-generator', () => ({
  base64ToUint8Array: (value: string) =>
    Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { downloadAlbumAsZip } from '../src/lib/album-download-service';
import { decryptAlbumNameWithTierKey } from '../src/lib/album-metadata-service';
import { loadPhoto } from '../src/lib/photo-service';
import { createShareLinkOriginalResolver } from '../src/lib/shared-album-download';

const VALID_SHA256 = 'A'.repeat(43);

function createPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    shardIds: ['thumb-1', 'preview-1', 'original-1'],
    epochId: 7,
    ...overrides,
  };
}

describe('W-S2 web download handle API cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDisplayableUrl.mockResolvedValue({
      url: 'blob:photo',
      mimeType: 'image/jpeg',
    });
    mocks.getOrFetchEpochKey.mockResolvedValue({
      epochId: 7,
      epochHandleId: 'epch_download_7',
      signPublicKey: new Uint8Array(32),
      signKeypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(0),
      },
    });
    mocks.downloadZip.mockImplementation((input: unknown) => {
      const iterable = input as AsyncIterable<{ input: Uint8Array }>;
      const consume = (async () => {
        for await (const _file of iterable) {
          // Consuming the generator triggers download + decrypt.
        }
      })();
      return new Response(
        new ReadableStream({
          async start(controller) {
            await consume;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
      );
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loadPhoto verifies integrity and decrypts through the epoch handle API', async () => {
    const encrypted = new Uint8Array([10, 20, 30]);
    const plaintext = new Uint8Array([1, 2, 3]);
    const crypto = {
      verifyShardIntegrity: vi.fn().mockResolvedValue(true),
      decryptShardWithEpochHandle: vi.fn().mockResolvedValue(plaintext),
    };
    mocks.downloadShards.mockResolvedValue([encrypted]);
    mocks.getCryptoClient.mockResolvedValue(crypto);

    await loadPhoto(
      'photo-handle',
      ['shard-1'],
      'epch_photo_7' as never,
      'image/jpeg',
      { skipCache: true },
      [VALID_SHA256],
    );

    expect(crypto.verifyShardIntegrity).toHaveBeenCalledWith(
      encrypted,
      new Uint8Array(32),
    );
    expect(crypto.decryptShardWithEpochHandle).toHaveBeenCalledWith(
      'epch_photo_7',
      encrypted,
    );
  });

  it('loadPhoto rejects the null bigint epoch handle sentinel before decrypting', async () => {
    const crypto = {
      verifyShardIntegrity: vi.fn(),
      decryptShardWithEpochHandle: vi.fn(),
    };
    mocks.getCryptoClient.mockResolvedValue(crypto);

    await expect(
      loadPhoto(
        'photo-zero',
        ['shard-1'],
        0n,
        'image/jpeg',
        { skipCache: true },
      ),
    ).rejects.toThrow('epochHandleId must be a non-zero crypto handle');
    expect(crypto.decryptShardWithEpochHandle).not.toHaveBeenCalled();
  });

  it('downloadAlbumAsZip round-trips an envelope through encrypt, mocked download, and handle decrypt', async () => {
    const handleId = 'epch_download_7';
    const plaintext = new Uint8Array([9, 8, 7]);
    const envelope = new Uint8Array([4, 5, 6]);
    const crypto = {
      encryptShardWithEpochHandle: vi.fn().mockResolvedValue(envelope),
      verifyShardIntegrity: vi.fn().mockResolvedValue(true),
      decryptShardWithEpochHandle: vi.fn().mockResolvedValue(plaintext),
    };
    mocks.getCryptoClient.mockResolvedValue(crypto);
    mocks.downloadShards.mockResolvedValue([envelope]);

    const encrypted = await crypto.encryptShardWithEpochHandle(
      handleId,
      plaintext,
      3,
      0,
    );
    expect(encrypted).toBe(envelope);

    await downloadAlbumAsZip({
      albumName: 'Handle Album',
      albumId: 'album-1',
      photos: [
        createPhoto({
          originalShardIds: ['original-1'],
          originalShardHashes: [VALID_SHA256],
        }),
      ],
    });

    expect(mocks.downloadShards).toHaveBeenCalledWith(['original-1']);
    expect(crypto.decryptShardWithEpochHandle).toHaveBeenCalledWith(
      handleId,
      envelope,
    );
  });

  it('decryptAlbumNameWithTierKey prefers link-tier handles over raw tier keys', async () => {
    const crypto = {
      decryptShardWithLinkTierHandle: vi
        .fn()
        .mockResolvedValue(new TextEncoder().encode('Shared')),
      decryptShardWithTierKey: vi.fn(),
    };
    mocks.getCryptoClient.mockResolvedValue(crypto);
    const envelope = new Uint8Array([1, 2, 3]);

    await expect(
      decryptAlbumNameWithTierKey(
        envelope,
        'link_tier_handle_3' as never,
        'album-1',
      ),
    ).resolves.toBe('Shared');

    expect(crypto.decryptShardWithLinkTierHandle).toHaveBeenCalledWith(
      'link_tier_handle_3',
      envelope,
    );
    expect(crypto.decryptShardWithTierKey).not.toHaveBeenCalled();
  });

  it('createShareLinkOriginalResolver uses handle header, integrity, and link-tier decrypt APIs', async () => {
    const envelope = new Uint8Array([7, 7, 7]);
    const crypto = {
      verifyShardIntegrity: vi.fn().mockResolvedValue(true),
      peekEnvelopeHeader: vi.fn().mockResolvedValue({
        version: 0x03,
        magic: 'SGzk',
        epoch: 7,
        shard: 9,
        tier: 3,
        nonce: new Uint8Array(24),
      }),
      decryptShardWithLinkTierHandle: vi
        .fn()
        .mockResolvedValue(new Uint8Array([42])),
    };
    mocks.getCryptoClient.mockResolvedValue(crypto);
    mocks.downloadShardViaShareLink.mockResolvedValue(envelope);

    const resolver = createShareLinkOriginalResolver({
      linkId: 'link-1',
      getTierKeyHandle: () => 'link_tier_handle_3' as never,
    });

    await expect(
      resolver(
        createPhoto({
          originalShardIds: [],
          shardIds: ['legacy-original'],
          shardHashes: [VALID_SHA256],
        }),
      ),
    ).resolves.toEqual(new Uint8Array([42]));

    expect(crypto.verifyShardIntegrity).toHaveBeenCalledWith(
      envelope,
      new Uint8Array(32),
    );
    expect(crypto.peekEnvelopeHeader).toHaveBeenCalledWith(envelope);
    expect(crypto.decryptShardWithLinkTierHandle).toHaveBeenCalledWith(
      'link_tier_handle_3',
      envelope,
    );
  });
});
