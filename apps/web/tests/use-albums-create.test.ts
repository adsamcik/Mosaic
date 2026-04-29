import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    listAlbums: vi.fn(),
    createAlbum: vi.fn(),
    createEpochKey: vi.fn(),
    deleteAlbum: vi.fn(),
    getCurrentUser: vi.fn(),
  },
  crypto: {
    getIdentityPublicKey: vi.fn(),
    generateEpochKey: vi.fn(),
    createEpochKeyBundle: vi.fn(),
    encryptShard: vi.fn(),
    encryptShardWithEpoch: vi.fn(),
    decryptShardWithEpoch: vi.fn(),
  },
  db: {
    getPhotoCount: vi.fn(),
    clearAlbumPhotos: vi.fn(),
  },
  epochStore: {
    clearAlbumKeys: vi.fn(),
    getCurrentEpochKey: vi.fn(),
    setEpochKey: vi.fn(),
  },
  syncEngine: {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  localPurge: {
    purgeLocalAlbum: vi.fn(),
  },
  memzero: vi.fn((buffer: Uint8Array) => buffer.fill(0)),
}));

vi.mock('../src/lib/api', () => ({
  getApi: () => mocks.api,
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () => Promise.resolve(mocks.crypto),
}));

vi.mock('../src/lib/db-client', () => ({
  getDbClient: () => Promise.resolve(mocks.db),
}));

vi.mock('../src/lib/album-metadata-service', () => ({
  getDecryptedAlbumName: vi.fn(),
  getStoredEncryptedName: vi.fn(),
  setStoredEncryptedName: vi.fn(),
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  ensureEpochKeysLoaded: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  clearAlbumKeys: mocks.epochStore.clearAlbumKeys,
  getCurrentEpochKey: mocks.epochStore.getCurrentEpochKey,
  setEpochKey: mocks.epochStore.setEpochKey,
}));

vi.mock('../src/lib/sync-engine', () => ({
  syncEngine: mocks.syncEngine,
}));

vi.mock('../src/lib/local-purge', () => ({
  purgeLocalAlbum: mocks.localPurge.purgeLocalAlbum,
}));

vi.mock('@mosaic/crypto', () => ({
  memzero: mocks.memzero,
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { useAlbums } from '../src/hooks/useAlbums';

interface UseAlbumsResult {
  createAlbum: (
    name: string,
    options?: { expiresAt?: string; expirationWarningDays?: number },
  ) => Promise<{
    id: string;
    name: string;
    decryptedName: string;
    photoCount: number;
    createdAt: string;
    isDecrypting: boolean;
    decryptionFailed: boolean;
    expiresAt?: string | null;
    expirationWarningDays?: number;
  } | null>;
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

describe('useAlbums createAlbum', () => {
  let container: HTMLElement;
  let root: Root;
  let hookResult: UseAlbumsResult;

  beforeEach(() => {
    vi.clearAllMocks();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookResult = undefined as unknown as UseAlbumsResult;

    mocks.api.listAlbums.mockResolvedValue([]);
    mocks.api.getCurrentUser.mockResolvedValue({ id: 'user-123' });
    mocks.api.createAlbum.mockResolvedValue({
      id: 'album-123',
      ownerId: 'user-123',
      currentVersion: 1,
      currentEpochId: 1,
      createdAt: '2024-01-01T00:00:00Z',
    });
    mocks.api.createEpochKey.mockResolvedValue({ id: 'epoch-1' });
    mocks.api.deleteAlbum.mockResolvedValue(undefined);
    mocks.crypto.getIdentityPublicKey.mockResolvedValue(new Uint8Array(32).fill(7));
    // Slice 3 — generateEpochKey returns an opaque handle id + publishable
    // wrapped seed + sign public key. No raw seed/sign secret bytes.
    mocks.crypto.generateEpochKey.mockResolvedValue({
      epochHandleId: 'epch_test-create',
      wrappedSeed: new Uint8Array(72).fill(1),
      signPublicKey: new Uint8Array(32).fill(2),
    });
    mocks.crypto.createEpochKeyBundle
      .mockResolvedValueOnce({
        encryptedBundle: new Uint8Array(10).fill(4),
        signature: new Uint8Array(64).fill(5),
      })
      .mockResolvedValueOnce({
        encryptedBundle: new Uint8Array(10).fill(6),
        signature: new Uint8Array(64).fill(7),
      });
    mocks.crypto.encryptShard.mockResolvedValue({
      ciphertext: new Uint8Array([1, 2, 3]),
      sha256: 'hash',
    });
    mocks.crypto.encryptShardWithEpoch.mockResolvedValue({
      envelopeBytes: new Uint8Array([1, 2, 3]),
      sha256: 'hash',
    });
    mocks.db.getPhotoCount.mockResolvedValue(0);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderHook(): void {
    function Harness() {
      hookResult = useAlbums() as unknown as UseAlbumsResult;
      return null;
    }

    act(() => {
      root.render(createElement(Harness));
    });
  }

  it('re-seals the owner epoch bundle with the real album id after creation', async () => {
    renderHook();
    await flush();

    let createdAlbum: Awaited<ReturnType<UseAlbumsResult['createAlbum']>> =
      null;
    await act(async () => {
      createdAlbum = await hookResult.createAlbum('My Album');
    });

    expect(createdAlbum).toEqual(
      expect.objectContaining({
        id: 'album-123',
        name: 'My Album',
      }),
    );
    expect(mocks.crypto.createEpochKeyBundle).toHaveBeenNthCalledWith(
      1,
      'epch_test-create',
      '',
      expect.any(Uint8Array),
    );
    expect(mocks.crypto.createEpochKeyBundle).toHaveBeenNthCalledWith(
      2,
      'epch_test-create',
      'album-123',
      expect.any(Uint8Array),
    );
    expect(mocks.api.createEpochKey).toHaveBeenCalledWith(
      'album-123',
      expect.objectContaining({
        recipientId: 'user-123',
        epochId: 1,
      }),
    );
    expect(mocks.api.deleteAlbum).not.toHaveBeenCalled();
  });

  it('passes expiration options to createAlbum and preserves them in local state', async () => {
    renderHook();
    await flush();

    mocks.api.createAlbum.mockResolvedValueOnce({
      id: 'album-expiring',
      ownerId: 'user-123',
      currentVersion: 1,
      currentEpochId: 1,
      createdAt: '2024-01-01T00:00:00Z',
      expiresAt: '2024-02-01T00:00:00.000Z',
      expirationWarningDays: 3,
    });

    let createdAlbum: Awaited<ReturnType<UseAlbumsResult['createAlbum']>> =
      null;
    await act(async () => {
      createdAlbum = await hookResult.createAlbum('Temp Album', {
        expiresAt: '2024-02-01T00:00:00.000Z',
        expirationWarningDays: 3,
      });
    });

    expect(mocks.api.createAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: '2024-02-01T00:00:00.000Z',
        expirationWarningDays: 3,
      }),
    );
    expect(createdAlbum).toEqual(
      expect.objectContaining({
        id: 'album-expiring',
        expiresAt: '2024-02-01T00:00:00.000Z',
        expirationWarningDays: 3,
      }),
    );
  });
});
