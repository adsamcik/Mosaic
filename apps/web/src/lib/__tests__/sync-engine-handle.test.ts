import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCryptoErrorCode, type EpochHandleId } from '../../workers/types';

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
    decryptShard: vi.fn(),
    encryptShard: vi.fn(),
    encryptManifestWithEpoch: vi.fn(),
    encryptShardWithEpoch: vi.fn(),
    decryptShardWithEpoch: vi.fn(),
  },
  getOrFetchEpochKey: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
  createLogger: () => mocks.logger,
}));

function expectNoRawSeedBytesThroughWorkerCalls(): void {
  const rawSeedSlots: Array<[string, number]> = [
    ['decryptManifestWithEpoch', 0],
    ['encryptManifestWithEpoch', 0],
    ['decryptShardWithEpoch', 0],
    ['encryptShardWithEpoch', 0],
    ['decryptShard', 1],
    ['encryptShard', 1],
  ];

  for (const [methodName, seedSlot] of rawSeedSlots) {
    const method = mocks.crypto[methodName as keyof typeof mocks.crypto];
    for (const call of method.mock.calls) {
      const candidate = call[seedSlot];
      expect(
        candidate instanceof Uint8Array && candidate.length === 32,
        `${methodName} arg ${seedSlot} must not receive a raw 32-byte epoch seed`,
      ).toBe(false);
    }
  }
}

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

  it('surfaces stale-handle errors without falling back to seed read', async () => {
    const staleHandleError = Object.assign(new Error('stale epoch handle'), {
      code: WorkerCryptoErrorCode.StaleHandle,
    });
    mocks.crypto.decryptManifestWithEpoch.mockRejectedValueOnce(
      staleHandleError,
    );
    const { syncEngine } = await import('../sync-engine');

    await expect(
      syncEngine.sync('album-1', 'epoch-handle-7' as EpochHandleId),
    ).rejects.toBe(staleHandleError);

    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.crypto.decryptManifestWithEpoch).toHaveBeenCalledWith(
      'epoch-handle-7',
      expect.any(Uint8Array),
    );
    expectNoRawSeedBytesThroughWorkerCalls();
  });

  it('never passes raw seed bytes through any worker call', async () => {
    const { syncEngine } = await import('../sync-engine');

    await syncEngine.sync('album-1', 'epoch-handle-7' as EpochHandleId);

    expect(mocks.crypto.decryptManifestWithEpoch).toHaveBeenCalledWith(
      'epoch-handle-7',
      expect.any(Uint8Array),
    );
    expectNoRawSeedBytesThroughWorkerCalls();
  });
});
