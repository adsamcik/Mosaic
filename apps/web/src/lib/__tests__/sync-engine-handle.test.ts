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
    getManifestSeqHighWater: vi.fn(),
    getAlbumEpochHighWater: vi.fn(),
    getManifestReplayCheckpoint: vi.fn(),
    listManifestReplayCheckpoints: vi.fn(),
  },
  crypto: {
    verifyManifestWithEpoch: vi.fn(),
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

class MockApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

vi.mock('../api', () => ({
  getApi: () => mocks.api,
  ApiError: MockApiError,
  fromBase64: (value: string) => {
    if (value === 'signer-pubkey') return new Uint8Array(32).fill(7);
    if (value === 'signature') return new Uint8Array(64).fill(8);
    return new TextEncoder().encode(value);
  },
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
    mocks.db.getManifestSeqHighWater.mockResolvedValue(null);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue(null);
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(null);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValue([]);
    mocks.crypto.verifyManifestWithEpoch.mockResolvedValue(true);
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          id: 'manifest-1',
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
          shardHashes: ['a'.repeat(64)],
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

  it('holds the cursor when a manifest sequence is zero', async () => {
    mocks.api.syncAlbum.mockResolvedValueOnce({
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
          manifestSeq: 0,
        },
      ],
    });

    const { syncEngine } = await import('../sync-engine');

    await syncEngine.sync('album-1', 'epoch-handle-7' as EpochHandleId);

    expect(mocks.crypto.verifyManifestWithEpoch).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).toHaveBeenLastCalledWith('album-1', 0);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Manifest sequence is outside the browser-safe integer range',
      expect.objectContaining({ manifestId: 'manifest-1' }),
    );
  });

  it('rejects a replay without an exact retained v2 head', async () => {
    let highWater: number | null = null;
    let albumVersion = 0;
    mocks.db.getAlbumVersion.mockImplementation(async () => albumVersion);
    mocks.db.getManifestSeqHighWater.mockImplementation(async () =>
      highWater,
    );
    mocks.db.insertManifests.mockImplementation(async (
      _manifests: unknown[],
      marks: Array<{ manifestSeq: number }> = [],
      checkpoint?: { albumVersion: number },
    ) => {
      highWater = marks[0]?.manifestSeq ?? highWater;
      if (checkpoint) {
        albumVersion = checkpoint.albumVersion;
      }
    });
    mocks.db.setAlbumVersion.mockImplementation(async (
      _albumId: string,
      version: number,
    ) => {
      albumVersion = version;
    });

    const replayedManifest = {
      id: 'manifest-1',
      albumId: 'album-1',
      versionCreated: 1,
      isDeleted: false,
      encryptedMeta: 'encrypted-meta',
      signature: 'signature',
      signerPubkey: 'signer-pubkey',
      shardIds: ['shard-1'],
      manifestSeq: 17,
    };

    mocks.api.syncAlbum
      .mockResolvedValueOnce({
        albumVersion: 1,
        currentEpochId: 7,
        hasMore: false,
        manifests: [replayedManifest],
      })
      .mockResolvedValueOnce({
        // A compromised server can attach a newer unsigned album cursor
        // to an old signed row. The durable v2 high-water must reject it.
        albumVersion: 2,
        currentEpochId: 7,
        hasMore: false,
        manifests: [{ ...replayedManifest, versionCreated: 2 }],
      });

    const { syncEngine } = await import('../sync-engine');

    await syncEngine.sync('album-1', 'epoch-handle-7' as EpochHandleId);
    await syncEngine.sync('album-1', 'epoch-handle-7' as EpochHandleId);

    expect(mocks.db.getManifestSeqHighWater).toHaveBeenCalled();
    expect(mocks.crypto.verifyManifestWithEpoch).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSeq: 17 }),
      expect.any(Uint8Array),
      expect.any(Uint8Array),
    );
    expect(mocks.db.insertManifests).toHaveBeenCalledTimes(1);
    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      expect.any(Array),
      [expect.objectContaining({ manifestSeq: 17 })],
      undefined,
      [expect.objectContaining({ epochId: 7, manifestSeq: 17 })],
      [expect.objectContaining({ epochId: 7 })],
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledTimes(2);
    expect(mocks.db.setAlbumVersion).toHaveBeenLastCalledWith('album-1', 1);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Manifest seq is stale and not an exact head',
      expect.objectContaining({ seq: 17, prevMax: 17 }),
    );
  });
});
