import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    decryptManifest: vi.fn(),
  },
  epochService: {
    fetchAndUnwrapEpochKeys: vi.fn(),
    getOrFetchEpochKey: vi.fn(),
  },
  epochStore: {
    clearAllEpochKeys: vi.fn(),
    getEpochKey: vi.fn(),
    setEpochKey: vi.fn(),
  },
  deriveTierKeys: vi.fn(),
  memzero: vi.fn((buffer: Uint8Array) => buffer.fill(0)),
  localPurge: {
    purgeLocalPhoto: vi.fn(),
  },
}));

vi.mock('../src/lib/api', () => ({
  getApi: () => mocks.api,
  fromBase64: (value: string) =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
}));

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(() => Promise.resolve(mocks.db)),
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() => Promise.resolve(mocks.crypto)),
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: mocks.epochService.fetchAndUnwrapEpochKeys,
  getOrFetchEpochKey: mocks.epochService.getOrFetchEpochKey,
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  clearAllEpochKeys: mocks.epochStore.clearAllEpochKeys,
  getEpochKey: mocks.epochStore.getEpochKey,
  setEpochKey: mocks.epochStore.setEpochKey,
}));

vi.mock('@mosaic/crypto', () => ({
  deriveTierKeys: mocks.deriveTierKeys,
  memzero: mocks.memzero,
}));


vi.mock('../src/lib/local-purge', () => ({
  purgeLocalPhoto: mocks.localPurge.purgeLocalPhoto,
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    startTimer: () => ({ end: vi.fn() }),
  }),
}));

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importSyncEngine() {
  vi.resetModules();
  const mod = await import('../src/lib/sync-engine');
  return mod.syncEngine;
}

describe('syncEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.db.getAlbumVersion.mockResolvedValue(0);
    mocks.db.insertManifests.mockResolvedValue(undefined);
    mocks.db.setAlbumVersion.mockResolvedValue(undefined);
    mocks.localPurge.purgeLocalPhoto.mockResolvedValue({
      albumId: 'album-1',
      purgedPhotoIds: ['manifest-deleted'],
      purgedAlbum: false,
      removedUploadTasks: 0,
      blockers: [],
    });
    mocks.crypto.verifyManifest.mockResolvedValue(true);
    mocks.crypto.decryptManifest.mockResolvedValue({
      assetId: 'asset-1',
      albumId: 'album-1',
      filename: 'image.jpg',
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      shardIds: ['shard-1'],
      epochId: 1,
    });
    mocks.epochService.getOrFetchEpochKey.mockResolvedValue({
      epochId: 7,
      epochSeed: new Uint8Array(32).fill(7),
      signKeypair: {
        publicKey: new Uint8Array(32).fill(9),
        secretKey: new Uint8Array(64).fill(4),
      },
    });
    mocks.deriveTierKeys.mockImplementation((epochSeed: Uint8Array) => ({
      thumbKey: new Uint8Array(epochSeed),
      previewKey: new Uint8Array(epochSeed.length).fill(2),
      fullKey: new Uint8Array(epochSeed.length).fill(3),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loops through paginated sync responses without queueing itself', async () => {
    const signer = new Uint8Array(32).fill(9);
    const manifest = {
      id: 'manifest-1',
      albumId: 'album-1',
      versionCreated: 1,
      isDeleted: false,
      encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
      signature: toBase64(new Uint8Array([4, 5, 6])),
      signerPubkey: toBase64(signer),
      shardIds: ['shard-1'],
    };

    mocks.api.syncAlbum
      .mockResolvedValueOnce({
        manifests: [manifest],
        currentEpochId: 7,
        albumVersion: 1,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        manifests: [{ ...manifest, id: 'manifest-2', versionCreated: 2 }],
        currentEpochId: 7,
        albumVersion: 2,
        hasMore: false,
      });

    const syncEngine = await importSyncEngine();

    await syncEngine.sync('album-1');

    expect(mocks.api.syncAlbum).toHaveBeenCalledTimes(2);
    expect(mocks.api.syncAlbum).toHaveBeenNthCalledWith(
      1,
      'album-1',
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.api.syncAlbum).toHaveBeenNthCalledWith(
      2,
      'album-1',
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenNthCalledWith(1, 'album-1', 1);
    expect(mocks.db.setAlbumVersion).toHaveBeenNthCalledWith(2, 'album-1', 2);
    expect(mocks.db.insertManifests).toHaveBeenCalledTimes(2);
    expect(syncEngine.isSyncing).toBe(false);
  });

  it('cancels an in-flight sync via AbortSignal', async () => {
    mocks.api.syncAlbum.mockImplementation(
      (
        _albumId: string,
        _sinceVersion: number,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Sync cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );

    const syncEngine = await importSyncEngine();

    const syncPromise = syncEngine.sync('album-1');
    syncEngine.cancel();

    await expect(syncPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(syncEngine.isSyncing).toBe(false);
  });

  it('fails closed when pagination does not advance album version', async () => {
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [],
      currentEpochId: 7,
      albumVersion: 0,
      hasMore: true,
    });

    const syncEngine = await importSyncEngine();

    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /did not advance album version/i,
    );

    expect(mocks.api.syncAlbum).toHaveBeenCalledTimes(1);
    expect(mocks.epochService.getOrFetchEpochKey).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
  });

  it('drains queued syncs after a guarded pagination failure', async () => {
    let resolveFirstSync: (() => void) | undefined;

    mocks.api.syncAlbum
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSync = () =>
              resolve({
                manifests: [],
                currentEpochId: 7,
                albumVersion: 0,
                hasMore: true,
              });
          }),
      )
      .mockResolvedValueOnce({
        manifests: [],
        currentEpochId: 7,
        albumVersion: 1,
        hasMore: false,
      });

    const syncEngine = await importSyncEngine();

    const firstSync = syncEngine.sync('album-1');
    const queuedSync = syncEngine.sync('album-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveFirstSync).toBeTypeOf('function');
    resolveFirstSync?.();

    await expect(firstSync).rejects.toThrow(/did not advance album version/i);
    await expect(queuedSync).resolves.toBeUndefined();
    expect(mocks.api.syncAlbum).toHaveBeenCalledTimes(2);
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 1);
  });

  it('aborts runaway pagination after hitting the iteration cap', async () => {
    mocks.api.syncAlbum.mockImplementation(
      async (_albumId: string, sinceVersion: number) => ({
        manifests: [],
        currentEpochId: 7,
        albumVersion: sinceVersion + 1,
        hasMore: true,
      }),
    );

    const syncEngine = await importSyncEngine();

    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /pagination iteration cap/i,
    );

    expect(mocks.api.syncAlbum).toHaveBeenCalledTimes(1000);
  });


  it('purges local photo data when sync observes a deleted manifest without decrypting metadata', async () => {
    const signer = new Uint8Array(32).fill(9);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: 'manifest-deleted',
          albumId: 'album-1',
          versionCreated: 3,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
        },
      ],
      currentEpochId: 7,
      albumVersion: 3,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();

    await syncEngine.sync('album-1');

    expect(mocks.localPurge.purgeLocalPhoto).toHaveBeenCalledWith({
      albumId: 'album-1',
      photoId: 'manifest-deleted',
      reason: 'sync-deleted',
    });
    expect(mocks.crypto.verifyManifest).not.toHaveBeenCalled();
    expect(mocks.crypto.decryptManifest).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'manifest-deleted',
        albumId: 'album-1',
        isDeleted: true,
        shardIds: ['encrypted-shard-1'],
      }),
    ]);
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 3);
  });

  it('skips manifests when server signer pubkey mismatches the cached epoch signing key', async () => {
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array([4, 5, 6])),
          signerPubkey: toBase64(new Uint8Array(32).fill(3)),
          shardIds: ['shard-1'],
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();

    await syncEngine.sync('album-1');

    expect(mocks.crypto.verifyManifest).not.toHaveBeenCalled();
    expect(mocks.crypto.decryptManifest).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 1);
  });

  it('rejects empty signer pubkeys from the server', async () => {
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array([4, 5, 6])),
          signerPubkey: toBase64(new Uint8Array(32)),
          shardIds: ['shard-1'],
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();

    await syncEngine.sync('album-1');

    expect(mocks.crypto.verifyManifest).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
  });

  it('zeroes all derived tier keys after manifest processing', async () => {
    const derivedKeys = {
      thumbKey: new Uint8Array([1]),
      previewKey: new Uint8Array([2]),
      fullKey: new Uint8Array([3]),
    };
    mocks.deriveTierKeys.mockReturnValueOnce(derivedKeys);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array([4, 5, 6])),
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();

    await syncEngine.sync('album-1');

    expect(mocks.memzero).toHaveBeenCalledWith(derivedKeys.thumbKey);
    expect(mocks.memzero).toHaveBeenCalledWith(derivedKeys.previewKey);
    expect(mocks.memzero).toHaveBeenCalledWith(derivedKeys.fullKey);
  });
});
