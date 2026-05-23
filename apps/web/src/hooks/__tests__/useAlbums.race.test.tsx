/**
 * v1.0.2 regression test for `v102-usealbums-stale-data-race`.
 *
 * loadAlbums() is called repeatedly (e.g. on mount + after a mutation refetch).
 * Without a monotonic request-id guard, an older in-flight load() can resolve
 * AFTER a newer one and overwrite the fresh `albums` state with stale values
 * (notably `expiresAt`, `decryptedName`). This test simulates two interleaved
 * loadAlbums() calls and verifies that only the newer call's albums survive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---- Mocks: keep the surface tiny so we exercise only the race guard. ----

const listAlbumsMock = vi.hoisted(() => vi.fn());
const getApiMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', () => ({
  // paginateAll terminates when the page is short; returning a 0..1 element
  // page is enough to stop after a single fetch.
  paginateAll: async (
    fetchPage: (skip: number, take: number) => Promise<unknown[]>,
  ) => fetchPage(0, 100),
  getApi: getApiMock,
  fromBase64: (_s: string) => new Uint8Array(),
  toBase64: (_b: Uint8Array) => '',
}));

vi.mock('../../lib/album-metadata-service', () => ({
  getStoredEncryptedName: () => null,
  setStoredEncryptedName: vi.fn(),
}));

vi.mock('../../lib/crypto-client', () => ({
  getCryptoClient: vi.fn(async () => ({})),
}));

vi.mock('../../lib/db-client', () => ({
  getDbClient: vi.fn(async () => ({
    getPhotoCount: vi.fn(async () => 0),
  })),
}));

vi.mock('../../lib/epoch-key-service', () => ({
  ensureEpochKeysLoaded: vi.fn(async () => false),
}));

vi.mock('../../lib/epoch-key-store', () => ({
  getCurrentEpochKey: () => null,
  setEpochKey: vi.fn(),
}));

vi.mock('../../lib/local-purge', () => ({
  purgeLocalAlbum: vi.fn(async () => ({ blockers: [] })),
}));

vi.mock('../../lib/sync-engine', () => ({
  syncEngine: {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
}));

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../lib/error-messages', () => ({
  toSafeErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

import { useAlbums } from '../useAlbums';

beforeEach(() => {
  listAlbumsMock.mockReset();
  getApiMock.mockReset();
  getApiMock.mockReturnValue({ listAlbums: listAlbumsMock });
});

afterEach(() => {
  // Unmount any roots created during the test.
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
});

const mountedRoots: Root[] = [];

async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function HookProbe({ onState }: { onState: (s: ReturnType<typeof useAlbums>) => void }) {
  const state = useAlbums();
  useEffect(() => {
    onState(state);
  });
  return null;
}

describe('useAlbums — request-generation guard (v1.0.2)', () => {
  it('stale loadAlbums() resolving after a fresh refetch does not overwrite albums', async () => {
    // First call returns STALE album with old expiresAt.
    // Second call returns FRESH album with new expiresAt.
    const stale = deferred<Array<Record<string, unknown>>>();
    const fresh = deferred<Array<Record<string, unknown>>>();
    listAlbumsMock
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);

    let latestState: ReturnType<typeof useAlbums> | null = null;
    const capture = (s: ReturnType<typeof useAlbums>) => {
      latestState = s;
    };

    await mount(<HookProbe onState={capture} />);

    // Mount fires the first loadAlbums (stale, pending). Now trigger refetch
    // (fires the second loadAlbums → fresh, pending). Do NOT await it — both
    // requests are mid-flight.
    let refetchPromise!: Promise<void>;
    await act(async () => {
      refetchPromise = latestState!.refetch();
      await Promise.resolve();
    });

    // Resolve fresh FIRST (the newer request) — albums should reflect it.
    await act(async () => {
      fresh.resolve([
        {
          id: 'album-fresh',
          createdAt: '2025-01-02T00:00:00Z',
          encryptedName: null,
          expiresAt: '2099-12-31T00:00:00Z',
        },
      ]);
      await refetchPromise;
      // Flush trailing microtasks (photoCount + decryptAlbumNames Promise.all).
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(latestState!.albums).toHaveLength(1);
    expect(latestState!.albums[0]!.id).toBe('album-fresh');
    expect(latestState!.albums[0]!.expiresAt).toBe('2099-12-31T00:00:00Z');

    // Now resolve the STALE request. Without the guard this would overwrite
    // the fresh state. With the guard it must be ignored.
    await act(async () => {
      stale.resolve([
        {
          id: 'album-stale',
          createdAt: '2025-01-01T00:00:00Z',
          encryptedName: null,
          expiresAt: '2000-01-01T00:00:00Z',
        },
      ]);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(latestState!.albums).toHaveLength(1);
    expect(latestState!.albums[0]!.id).toBe('album-fresh');
    expect(latestState!.albums[0]!.expiresAt).toBe('2099-12-31T00:00:00Z');
  });

  it('error from a stale loadAlbums() does not clobber fresh albums', async () => {
    const stale = deferred<Array<Record<string, unknown>>>();
    const fresh = deferred<Array<Record<string, unknown>>>();
    listAlbumsMock
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);

    let latestState: ReturnType<typeof useAlbums> | null = null;
    const capture = (s: ReturnType<typeof useAlbums>) => {
      latestState = s;
    };

    await mount(<HookProbe onState={capture} />);

    let refetchPromise!: Promise<void>;
    await act(async () => {
      refetchPromise = latestState!.refetch();
      await Promise.resolve();
    });

    await act(async () => {
      fresh.resolve([
        {
          id: 'album-fresh',
          createdAt: '2025-01-02T00:00:00Z',
          encryptedName: null,
          expiresAt: null,
        },
      ]);
      await refetchPromise;
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(latestState!.error).toBeNull();
    expect(latestState!.albums).toHaveLength(1);

    // Stale request now fails — error must NOT propagate to UI.
    await act(async () => {
      // Reject by sending an error through resolve-of-rejection isn't valid;
      // instead, attach a rejection by re-mocking would be complex. We
      // simulate rejection by rejecting the deferred directly.
      (stale as unknown as { resolve: (v: unknown) => void }).resolve(
        Promise.reject(new Error('stale network failure')),
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(latestState!.error).toBeNull();
    expect(latestState!.albums).toHaveLength(1);
    expect(latestState!.albums[0]!.id).toBe('album-fresh');
  });
});
