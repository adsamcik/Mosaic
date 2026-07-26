import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    verifySignatureWithEpoch: vi.fn(),
    decryptManifestWithEpoch: vi.fn(),
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
  localPurge: {
    purgeLocalPhoto: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    startTimer: vi.fn(() => ({ end: vi.fn() })),
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

vi.mock('../src/lib/api', () => ({
  getApi: () => mocks.api,
  ApiError: MockApiError,
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

vi.mock('../src/lib/local-purge', () => ({
  purgeLocalPhoto: mocks.localPurge.purgeLocalPhoto,
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => mocks.logger,
}));

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importSyncEngine() {
  vi.resetModules();
  const mod = await import('../src/lib/sync-engine');
  return mod.syncEngine;
}

const SAMPLE_PHOTO_META = {
  id: 'manifest-1',
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
  shardHashes: ['a'.repeat(64)],
  epochId: 7,
};

const SAMPLE_PHOTO_META_BYTES = new TextEncoder().encode(
  JSON.stringify(SAMPLE_PHOTO_META),
);

describe('syncEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.db.getAlbumVersion.mockResolvedValue(0);
    mocks.db.insertManifests.mockResolvedValue(undefined);
    mocks.db.setAlbumVersion.mockResolvedValue(undefined);
    mocks.db.getManifestSeqHighWater.mockResolvedValue(null);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue(null);
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(null);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValue([]);
    mocks.localPurge.purgeLocalPhoto.mockResolvedValue({
      albumId: 'album-1',
      purgedPhotoIds: ['manifest-deleted'],
      purgedAlbum: false,
      removedUploadTasks: 0,
      blockers: [],
    });
    mocks.crypto.verifyManifestWithEpoch.mockResolvedValue(true);
    mocks.crypto.verifySignatureWithEpoch.mockResolvedValue(true);
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValue(
      SAMPLE_PHOTO_META_BYTES,
    );
    mocks.epochService.fetchAndUnwrapEpochKeys.mockResolvedValue([]);
    mocks.epochService.getOrFetchEpochKey.mockResolvedValue({
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      signPublicKey: new Uint8Array(32).fill(9),
      // Slice 3 zero-filled placeholders kept until Slice 4-7 retire callers.
      epochSeed: new Uint8Array(0),
      signKeypair: {
        publicKey: new Uint8Array(32).fill(9),
        secretKey: new Uint8Array(0),
      },
    });
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
      signature: toBase64(new Uint8Array(64).fill(4)),
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
        manifests: [{ ...manifest, versionCreated: 2 }],
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
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledTimes(1);
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 2);
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

  it('purges local photo data when sync observes a signed tombstone (A2)', async () => {
    const signer = new Uint8Array(32).fill(9);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 3,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(0xab)),
          tombstoneSignerEpochId: 7,
        },
      ],
      currentEpochId: 7,
      albumVersion: 3,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();

    await syncEngine.sync('00000000-1111-2222-3333-444444444444');

    expect(mocks.crypto.verifySignatureWithEpoch).toHaveBeenCalledTimes(1);
    expect(mocks.localPurge.purgeLocalPhoto).toHaveBeenCalledWith({
      albumId: '00000000-1111-2222-3333-444444444444',
      photoId: '11111111-2222-3333-4444-555555555555',
      reason: 'sync-deleted',
    });
    expect(mocks.crypto.decryptManifestWithEpoch).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          isDeleted: true,
          shardIds: ['encrypted-shard-1'],
        }),
      ],
      [],
      undefined,
      [],
      [
        expect.objectContaining({
          albumId: '00000000-1111-2222-3333-444444444444',
          epochId: 7,
        }),
      ],
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith(
      '00000000-1111-2222-3333-444444444444',
      3,
    );
  });

  it('verifies and durably checkpoints a v2 tombstone sequence before purge', async () => {
    const signer = new Uint8Array(32).fill(9);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 8,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(0xab)),
          tombstoneSignerEpochId: 7,
          tombstoneProtocolVersion: 2,
          tombstoneSeq: 11,
          tombstoneVersionCreated: 3,
        },
      ],
      currentEpochId: 7,
      albumVersion: 8,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('00000000-1111-2222-3333-444444444444');

    expect(mocks.crypto.verifySignatureWithEpoch).toHaveBeenCalledTimes(1);
    const transcript = mocks.crypto.verifySignatureWithEpoch.mock
      .calls[0]?.[0] as Uint8Array;
    expect(transcript).toHaveLength(72);
    expect(Array.from(transcript.slice(40, 48))).toEqual([
      11, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(mocks.localPurge.purgeLocalPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [expect.objectContaining({ id: '11111111-2222-3333-4444-555555555555' })],
      [expect.objectContaining({ manifestSeq: 11 })],
      undefined,
      [
        expect.objectContaining({
          manifestSeq: 11,
          operationKind: 'Tombstone',
        }),
      ],
      [expect.objectContaining({ epochId: 7 })],
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith(
      '00000000-1111-2222-3333-444444444444',
      8,
    );
  });

  it('rejects a verified v2 tombstone at the persisted signer floor', async () => {
    const signer = new Uint8Array(32).fill(9);
    mocks.db.getManifestSeqHighWater.mockResolvedValue(11);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 8,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(0xab)),
          tombstoneSignerEpochId: 7,
          tombstoneProtocolVersion: 2,
          tombstoneSeq: 11,
          tombstoneVersionCreated: 3,
        },
      ],
      currentEpochId: 7,
      albumVersion: 8,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('00000000-1111-2222-3333-444444444444');

    expect(mocks.crypto.verifySignatureWithEpoch).toHaveBeenCalledTimes(1);
    expect(mocks.db.getManifestSeqHighWater).toHaveBeenCalledTimes(1);
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Tombstone seq is stale and not an exact head',
      expect.objectContaining({ seq: 11, prevMax: 11 }),
    );
  });

  it('refuses to purge on unsigned tombstone (audit sync C2)', async () => {
    // Pre-A2 tombstones (no signature) MUST NOT be honored — a malicious
    // server cannot forge deletions to purge local state.
    const signer = new Uint8Array(32).fill(9);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 3,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
          // No tombstoneSignature / tombstoneSignerEpochId
        },
      ],
      currentEpochId: 7,
      albumVersion: 3,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('00000000-1111-2222-3333-444444444444');

    expect(mocks.crypto.verifySignatureWithEpoch).not.toHaveBeenCalled();
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
    // Skip clamps cursor advance: cursor must not advance past the
    // suspicious tombstone so the next sync run retries (this is
    // sync C1/C3/C4 "skip-aware cursor" behavior re-used).
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalledWith(
      '00000000-1111-2222-3333-444444444444',
      3,
    );
  });

  it('refuses to purge on tombstone with invalid signature', async () => {
    const signer = new Uint8Array(32).fill(9);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 3,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(0xab)),
          tombstoneSignerEpochId: 7,
        },
      ],
      currentEpochId: 7,
      albumVersion: 3,
      hasMore: false,
    });

    mocks.crypto.verifySignatureWithEpoch.mockResolvedValueOnce(false);

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('00000000-1111-2222-3333-444444444444');

    expect(mocks.crypto.verifySignatureWithEpoch).toHaveBeenCalledTimes(1);
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalledWith(
      '00000000-1111-2222-3333-444444444444',
      3,
    );
  });

  it('refuses to purge on tombstone with wrong-length signature', async () => {
    const signer = new Uint8Array(32).fill(9);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 3,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(signer),
          shardIds: ['encrypted-shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(63)), // not 64 bytes
          tombstoneSignerEpochId: 7,
        },
      ],
      currentEpochId: 7,
      albumVersion: 3,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('00000000-1111-2222-3333-444444444444');

    expect(mocks.crypto.verifySignatureWithEpoch).not.toHaveBeenCalled();
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
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
          signature: toBase64(new Uint8Array(64).fill(4)),
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

    expect(mocks.crypto.verifyManifestWithEpoch).not.toHaveBeenCalled();
    expect(mocks.crypto.decryptManifestWithEpoch).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 0);
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
          signature: toBase64(new Uint8Array(64).fill(4)),
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

    expect(mocks.crypto.verifyManifestWithEpoch).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
  });

  it('routes manifest decryption through the epoch handle (Slice 4)', async () => {
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
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

    expect(mocks.crypto.decryptManifestWithEpoch).toHaveBeenCalledTimes(1);
    const [handleId, envelopeBytes] =
      mocks.crypto.decryptManifestWithEpoch.mock.calls[0]!;
    expect(handleId).toBe('epoch-handle-7');
    expect(envelopeBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.db.insertManifests).toHaveBeenCalledTimes(1);
  });

  it('logs and skips manifests whose canonical epoch signature does not verify', async () => {
    mocks.crypto.verifyManifestWithEpoch.mockResolvedValueOnce(false);
    mocks.api.syncAlbum.mockResolvedValue({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
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

    expect(mocks.crypto.verifyManifestWithEpoch).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Manifest signature verification failed',
      expect.objectContaining({ albumId: 'album-1', manifestId: 'manifest-1' }),
    );
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 0);
  });

  it.each([
    ['manifest id', { ...SAMPLE_PHOTO_META, id: 'swapped-manifest' }],
    ['album id', { ...SAMPLE_PHOTO_META, albumId: 'swapped-album' }],
  ])('rejects a signed payload with a swapped %s', async (_label, meta) => {
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify(meta)),
    );
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
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

    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 0);
  });

  it('fails closed when the server rolls an album back to an older signing epoch', async () => {
    mocks.db.getAlbumEpochHighWater.mockResolvedValueOnce({
      albumId: 'album-1',
      epochId: 8,
      signerKey: '08'.repeat(32),
    });
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [],
      currentEpochId: 7,
      albumVersion: 0,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /signing epoch regressed/i,
    );
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
  });

  it('allows a verified higher epoch to supersede the retained manifest head', async () => {
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '11'.repeat(64),
    };
    mocks.db.getAlbumEpochHighWater.mockResolvedValueOnce({
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.epochService.getOrFetchEpochKey.mockResolvedValue({
      epochId: 8,
      epochHandleId: 'epoch-handle-8',
      signPublicKey: new Uint8Array(32).fill(8),
      epochSeed: new Uint8Array(0),
      signKeypair: {
        publicKey: new Uint8Array(32).fill(8),
        secretKey: new Uint8Array(0),
      },
    });
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValueOnce(
      new TextEncoder().encode(
        JSON.stringify({ ...SAMPLE_PHOTO_META, epochId: 8 }),
      ),
    );
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(8)),
          signerPubkey: toBase64(new Uint8Array(32).fill(8)),
          shardIds: ['shard-1'],
          manifestSeq: 1,
        },
      ],
      currentEpochId: 8,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('album-1');

    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'manifest-1' })],
      [expect.objectContaining({ manifestSeq: 1 })],
      undefined,
      [expect.objectContaining({ epochId: 8, signerKey: '08'.repeat(32) })],
      [expect.objectContaining({ epochId: 8, signerKey: '08'.repeat(32) })],
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 1);
  });

  it('rehydrates an unchanged historical-epoch live head after album key rotation', async () => {
    const oldSigner = new Uint8Array(32).fill(9);
    const currentSigner = new Uint8Array(32).fill(8);
    const oldBundle = {
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      signPublicKey: oldSigner,
      signKeypair: { publicKey: oldSigner, secretKey: new Uint8Array(0) },
    };
    const currentBundle = {
      epochId: 8,
      epochHandleId: 'epoch-handle-8',
      signPublicKey: currentSigner,
      signKeypair: { publicKey: currentSigner, secretKey: new Uint8Array(0) },
    };
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getManifestSeqHighWater.mockResolvedValue(11);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 8,
      signerKey: '08'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.epochService.getOrFetchEpochKey.mockImplementation(
      async (_albumId: string, epochId: number) =>
        epochId === 8 ? currentBundle : oldBundle,
    );
    mocks.epochService.fetchAndUnwrapEpochKeys.mockResolvedValue([
      currentBundle,
      oldBundle,
    ]);
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify(SAMPLE_PHOTO_META)),
    );
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
          signerPubkey: toBase64(oldSigner),
          shardIds: ['shard-1'],
          manifestSeq: 11,
        },
      ],
      currentEpochId: 8,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('album-1');

    expect(mocks.epochService.fetchAndUnwrapEpochKeys).toHaveBeenCalledWith(
      'album-1',
    );
    expect(mocks.crypto.decryptManifestWithEpoch).toHaveBeenCalledWith(
      'epoch-handle-7',
      new Uint8Array([1, 2, 3]),
    );
    expect(mocks.crypto.verifyManifestWithEpoch).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSeq: 11 }),
      expect.any(Uint8Array),
      oldSigner,
    );
    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'manifest-1' })],
      [],
      undefined,
      [],
      [{ albumId: 'album-1', epochId: 8, signerKey: '08'.repeat(32) }],
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 1);
  });

  it('rehydrates and purges an exact historical-epoch v2 tombstone after rotation', async () => {
    const albumId = '00000000-1111-2222-3333-444444444444';
    const manifestId = '11111111-2222-3333-4444-555555555555';
    const oldSigner = new Uint8Array(32).fill(9);
    const currentSigner = new Uint8Array(32).fill(8);
    const oldBundle = {
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      signPublicKey: oldSigner,
      signKeypair: { publicKey: oldSigner, secretKey: new Uint8Array(0) },
    };
    const currentBundle = {
      epochId: 8,
      epochHandleId: 'epoch-handle-8',
      signPublicKey: currentSigner,
      signKeypair: { publicKey: currentSigner, secretKey: new Uint8Array(0) },
    };
    const retainedHead = {
      albumId,
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId,
      manifestSeq: 12,
      operationKind: 'Tombstone' as const,
      signatureFingerprint: 'ab'.repeat(64),
    };
    mocks.db.getManifestSeqHighWater.mockResolvedValue(12);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId,
      epochId: 8,
      signerKey: '08'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.epochService.getOrFetchEpochKey.mockImplementation(
      async (_albumId: string, epochId: number) =>
        epochId === 8 ? currentBundle : oldBundle,
    );
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: manifestId,
          albumId,
          versionCreated: 8,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(oldSigner),
          shardIds: ['encrypted-shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(0xab)),
          tombstoneSignerEpochId: 7,
          tombstoneProtocolVersion: 2,
          tombstoneSeq: 12,
          tombstoneVersionCreated: 3,
        },
      ],
      currentEpochId: 8,
      albumVersion: 8,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync(albumId);

    expect(mocks.crypto.verifySignatureWithEpoch).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Uint8Array),
      oldSigner,
    );
    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [expect.objectContaining({ id: manifestId, isDeleted: true })],
      [],
      undefined,
      [],
      [{ albumId, epochId: 8, signerKey: '08'.repeat(32) }],
    );
    expect(mocks.localPurge.purgeLocalPhoto).toHaveBeenCalledWith({
      albumId,
      photoId: manifestId,
      reason: 'sync-deleted',
    });
    expect(mocks.db.insertManifests.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.localPurge.purgeLocalPhoto.mock.invocationCallOrder[0]!,
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith(albumId, 8);
  });

  it('rehydrates an exact retained v2 head after a disposable cache rebuild', async () => {
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getManifestSeqHighWater.mockResolvedValue(11);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
          manifestSeq: 11,
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('album-1');

    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'manifest-1' })],
      [],
      undefined,
      [],
      [expect.objectContaining({ epochId: 7 })],
    );
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 1);
  });

  it('does not complete a security-bearing rebuild with an unverified terminal suffix', async () => {
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getManifestSeqHighWater.mockResolvedValue(11);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockImplementation(
      async (_albumId: string, manifestId: string) =>
        manifestId === retainedHead.manifestId ? retainedHead : null,
    );
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
          manifestSeq: 11,
        },
        {
          id: 'manifest-2',
          albumId: 'album-1',
          versionCreated: 2,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([4, 5, 6])),
          signature: toBase64(new Uint8Array(64).fill(5)),
          signerPubkey: toBase64(new Uint8Array(32)),
          shardIds: ['shard-2'],
        },
      ],
      currentEpochId: 7,
      albumVersion: 2,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /fully verified terminal state/i,
    );
    expect(mocks.db.insertManifests).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'manifest-1' })],
      [],
      undefined,
      [],
      [expect.objectContaining({ epochId: 7 })],
    );
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
  });

  it('rejects an older captured v2 state during a full cache rebuild', async () => {
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getManifestSeqHighWater.mockResolvedValue(11);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(3)),
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
          manifestSeq: 10,
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /Full rebuild omitted/i,
    );
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
  });

  it('rejects a captured historical-epoch v2 replay during rebuild after rotation', async () => {
    const oldSigner = new Uint8Array(32).fill(9);
    const currentSigner = new Uint8Array(32).fill(8);
    const oldBundle = {
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      signPublicKey: oldSigner,
      signKeypair: { publicKey: oldSigner, secretKey: new Uint8Array(0) },
    };
    const currentBundle = {
      epochId: 8,
      epochHandleId: 'epoch-handle-8',
      signPublicKey: currentSigner,
      signKeypair: { publicKey: currentSigner, secretKey: new Uint8Array(0) },
    };
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getManifestSeqHighWater.mockResolvedValue(11);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 8,
      signerKey: '08'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.epochService.getOrFetchEpochKey.mockImplementation(
      async (_albumId: string, epochId: number) =>
        epochId === 8 ? currentBundle : oldBundle,
    );
    mocks.epochService.fetchAndUnwrapEpochKeys.mockResolvedValue([
      currentBundle,
      oldBundle,
    ]);
    mocks.crypto.decryptManifestWithEpoch.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify(SAMPLE_PHOTO_META)),
    );
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(3)),
          signerPubkey: toBase64(oldSigner),
          shardIds: ['shard-1'],
          manifestSeq: 10,
        },
      ],
      currentEpochId: 8,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /Full rebuild omitted/i,
    );

    expect(mocks.crypto.decryptManifestWithEpoch).toHaveBeenCalledWith(
      'epoch-handle-7',
      expect.any(Uint8Array),
    );
    expect(mocks.crypto.verifyManifestWithEpoch).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSeq: 10 }),
      expect.any(Uint8Array),
      oldSigner,
    );
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Manifest seq is stale and not an exact head',
      expect.objectContaining({ seq: 10, prevMax: 11 }),
    );
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
  });

  it('rejects a legacy historical tombstone downgrade after rotation', async () => {
    const oldSigner = new Uint8Array(32).fill(9);
    const currentSigner = new Uint8Array(32).fill(8);
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 8,
      signerKey: '08'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.epochService.getOrFetchEpochKey.mockResolvedValue({
      epochId: 8,
      epochHandleId: 'epoch-handle-8',
      signPublicKey: currentSigner,
      signKeypair: {
        publicKey: currentSigner,
        secretKey: new Uint8Array(0),
      },
    });
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(oldSigner),
          shardIds: ['shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(4)),
          tombstoneSignerEpochId: 7,
        },
      ],
      currentEpochId: 8,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /Full rebuild omitted/i,
    );

    expect(mocks.crypto.verifySignatureWithEpoch).not.toHaveBeenCalled();
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
  });

  it('rejects an ordinary-sync legacy live downgrade with a forged newer cursor', async () => {
    mocks.db.getAlbumVersion.mockResolvedValueOnce(5);
    mocks.db.getAlbumEpochHighWater.mockResolvedValue({
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
    });
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue({
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live',
      signatureFingerprint: '04'.repeat(64),
    });
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 6,
          isDeleted: false,
          encryptedMeta: toBase64(new Uint8Array([1, 2, 3])),
          signature: toBase64(new Uint8Array(64).fill(4)),
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
        },
      ],
      currentEpochId: 7,
      albumVersion: 99,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await syncEngine.sync('album-1');

    expect(mocks.crypto.decryptManifestWithEpoch).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
    expect(mocks.db.setAlbumVersion).toHaveBeenCalledWith('album-1', 5);
  });

  it('does not purge a legacy tombstone during a full rebuild with a retained v2 head', async () => {
    const retainedHead = {
      albumId: 'album-1',
      epochId: 7,
      signerKey: '09'.repeat(32),
      manifestId: 'manifest-1',
      manifestSeq: 11,
      operationKind: 'Live' as const,
      signatureFingerprint: '04'.repeat(64),
    };
    mocks.db.getManifestReplayCheckpoint.mockResolvedValue(retainedHead);
    mocks.db.listManifestReplayCheckpoints.mockResolvedValueOnce([
      retainedHead,
    ]);
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: 'manifest-1',
          albumId: 'album-1',
          versionCreated: 1,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(4)),
          tombstoneSignerEpochId: 7,
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync('album-1')).rejects.toThrow(
      /Full rebuild omitted/i,
    );
    expect(mocks.crypto.verifySignatureWithEpoch).not.toHaveBeenCalled();
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests).not.toHaveBeenCalled();
  });

  it('keeps the cursor behind a v2 tombstone until every local purge step completes', async () => {
    const albumId = '00000000-1111-2222-3333-444444444444';
    const manifestId = '11111111-2222-3333-4444-555555555555';
    mocks.db.getAlbumVersion.mockResolvedValueOnce(5);
    mocks.localPurge.purgeLocalPhoto.mockResolvedValueOnce({
      albumId,
      purgedPhotoIds: [manifestId],
      purgedAlbum: false,
      removedUploadTasks: 0,
      blockers: ['upload-queue-purge-failed'],
    });
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: manifestId,
          albumId,
          versionCreated: 6,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(4)),
          tombstoneSignerEpochId: 7,
          tombstoneProtocolVersion: 2,
          tombstoneSeq: 12,
          tombstoneVersionCreated: 1,
        },
      ],
      currentEpochId: 7,
      albumVersion: 6,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(syncEngine.sync(albumId)).rejects.toThrow(
      /Local purge did not complete/i,
    );

    expect(mocks.db.insertManifests).toHaveBeenCalledTimes(1);
    expect(mocks.localPurge.purgeLocalPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.db.setAlbumVersion).not.toHaveBeenCalled();
    expect(mocks.db.insertManifests.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.localPurge.purgeLocalPhoto.mock.invocationCallOrder[0]!,
    );
  });

  it('never purges a v2 tombstone when replay-security persistence fails', async () => {
    mocks.db.insertManifests.mockRejectedValueOnce(
      new Error('security write failed'),
    );
    mocks.api.syncAlbum.mockResolvedValueOnce({
      manifests: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          albumId: '00000000-1111-2222-3333-444444444444',
          versionCreated: 1,
          isDeleted: true,
          encryptedMeta: '',
          signature: '',
          signerPubkey: toBase64(new Uint8Array(32).fill(9)),
          shardIds: ['shard-1'],
          tombstoneSignature: toBase64(new Uint8Array(64).fill(4)),
          tombstoneSignerEpochId: 7,
          tombstoneProtocolVersion: 2,
          tombstoneSeq: 12,
          tombstoneVersionCreated: 1,
        },
      ],
      currentEpochId: 7,
      albumVersion: 1,
      hasMore: false,
    });

    const syncEngine = await importSyncEngine();
    await expect(
      syncEngine.sync('00000000-1111-2222-3333-444444444444'),
    ).rejects.toThrow('security write failed');
    expect(mocks.localPurge.purgeLocalPhoto).not.toHaveBeenCalled();
  });
});
