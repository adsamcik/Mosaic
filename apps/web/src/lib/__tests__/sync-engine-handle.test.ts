import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochHandleId } from '../../workers/types';

const mocks = vi.hoisted(() => ({
  api: {
    syncAlbum: vi.fn(),
  },
  db: {
    getAlbumVersion: vi.fn(),
    insertManifests: vi.fn(),
    setAlbumVersion: vi.fn(),
  },
  crypto: {
    verifyManifest: vi.fn(),
    decryptManifestWithEpoch: vi.fn(),
  },
  getOrFetchEpochKey: vi.fn(),
}));

vi.mock('../api', () => ({
  getApi: () => mocks.api,
  fromBase64: (value: string) =>
    value === 'signer-pubkey'
      ? new Uint8Array(32).fill(7)
      : new TextEncoder().encode(value),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: () => Promise.resolve(mocks.crypto),
}));

vi.mock('../db-client', () => ({
  getDbClient: () => Promise.resolve(mocks.db),
}));

vi.mock('../epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: vi.fn(),
  getOrFetchEpochKey: (...args: unknown[]) => mocks.getOrFetchEpochKey(...args),
}));

vi.mock('../local-purge', () => ({
  purgeLocalPhoto: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('syncEngine handle-based manifest decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.getAlbumVersion.mockResolvedValue(0);
    mocks.db.insertManifests.mockResolvedValue(undefined);
    mocks.db.setAlbumVersion.mockResolvedValue(undefined);
    mocks.crypto.verifyManifest.mockResolvedValue(true);
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          id: 'photo-1',
          assetId: 'asset-1',
          albumId: 'album-1',
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
          tags: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          shardIds: ['shard-1'],
          epochId: 7,
        }),
      ),
    );
    mocks.getOrFetchEpochKey.mockResolvedValue({
      epochId: 7,
      epochHandleId: 'epoch-handle-7' as EpochHandleId,
      signPublicKey: new Uint8Array(32).fill(7),
      signKeypair: {
        publicKey: new Uint8Array(32).fill(7),
        secretKey: new Uint8Array(0),
      },
    });
    mocks.api.syncAlbum.mockResolvedValue({
      albumVersion: 1,
      currentEpochId: 7,
      hasMore: false,
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: 'encrypted-meta',
          signature: 'signature',
          signerPubkey: 'signer-pubkey',
          shardIds: ['shard-1'],
        },
      ],
    });
  });

  it('decrypts synced manifests with the epoch handle id', async () => {
    const { syncEngine } = await import('../sync-engine');

    await syncEngine.sync('album-1', 'epoch-handle-7' as EpochHandleId);

    expect(mocks.crypto.decryptManifestWithEpoch).toHaveBeenCalledWith(
      'epoch-handle-7',
      expect.any(Uint8Array),
    );
    expect(mocks.db.insertManifests).toHaveBeenCalledTimes(1);
  });
});
