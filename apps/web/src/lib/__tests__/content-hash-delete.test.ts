import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDBPDatabase } from 'idb';
import {
  ALBUM_CONTENT_HASHES_STORE,
  ContentHashDedup,
  ensureContentHashStores,
} from '../content-hash';
import type { AlbumContentHashRecord, UploadQueueDB } from '../upload/types';

const apiMocks = vi.hoisted(() => ({
  deleteManifest: vi.fn<() => Promise<void>>(),
}));

const dbMocks = vi.hoisted(() => ({
  deleteManifest: vi.fn<() => Promise<void>>(),
}));

const dedupMocks = vi.hoisted(() => ({
  deleteByPhotoId: vi.fn<() => Promise<void>>(),
}));

vi.mock('../api', () => ({
  getApi: () => apiMocks,
}));

vi.mock('../db-client', () => ({
  getDbClient: async () => dbMocks,
}));

vi.mock('../album-cover-service', () => ({
  getCachedCover: () => null,
  releaseCover: vi.fn(),
}));

vi.mock('../photo-service', () => ({
  releasePhoto: vi.fn(),
  releaseThumbnail: vi.fn(),
}));

interface HookResult {
  deletePhoto: (manifestId: string, albumId: string) => Promise<void>;
  deletePhotos: (
    manifestIds: string[],
    albumId: string,
  ) => Promise<{ successCount: number; failureCount: number; failedIds: string[]; errors: string[] }>;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderPhotoActionsHook(): Promise<{ result: () => HookResult; unmount: () => Promise<void> }> {
  const { usePhotoActions } = await import('../../hooks/usePhotoActions');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: HookResult | null = null;

  function TestComponent(): null {
    current = usePhotoActions();
    return null;
  }

  await act(async () => {
    root.render(createElement(TestComponent));
    await flush();
  });

  return {
    result: () => {
      if (!current) throw new Error('hook not mounted');
      return current;
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      container.remove();
    },
  };
}

describe('ContentHashDedup deletion', () => {
  let records: AlbumContentHashRecord[];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    apiMocks.deleteManifest.mockResolvedValue(undefined);
    dbMocks.deleteManifest.mockResolvedValue(undefined);
    dedupMocks.deleteByPhotoId.mockResolvedValue(undefined);
    records = [
      { albumId: 'album-a', contentHash: 'a'.repeat(64), photoId: 'photo-a', dateAdded: 1 },
      { albumId: 'album-a', contentHash: 'b'.repeat(64), photoId: 'photo-b', dateAdded: 2 },
      { albumId: 'album-b', contentHash: 'a'.repeat(64), photoId: 'photo-a', dateAdded: 3 },
    ];
  });

  it('deleteByContentHash removes only the matching album hash row', async () => {
    const fakeDb = {
      delete: async (_store: string, key: [string, string]) => {
        records = records.filter((record) => record.albumId !== key[0] || record.contentHash !== key[1]);
      },
    } as unknown as IDBPDatabase<UploadQueueDB>;
    const dedup = new ContentHashDedup(fakeDb);

    await dedup.deleteByContentHash('album-a', 'a'.repeat(64));

    expect(records).toEqual([
      { albumId: 'album-a', contentHash: 'b'.repeat(64), photoId: 'photo-b', dateAdded: 2 },
      { albumId: 'album-b', contentHash: 'a'.repeat(64), photoId: 'photo-a', dateAdded: 3 },
    ]);
  });

  it('deleteByPhotoId removes every matching row within the album only', async () => {
    const fakeDb = {
      transaction: () => ({
        store: {
          index: (name: string) => ({
            getAllKeys: async (key: [string, string]) => {
              expect(name).toBe('album-photo');
              return records
                .filter((record) => record.albumId === key[0] && record.photoId === key[1])
                .map((record) => [record.albumId, record.contentHash] as [string, string]);
            },
          }),
          delete: async (key: [string, string]) => {
            records = records.filter((record) => record.albumId !== key[0] || record.contentHash !== key[1]);
          },
        },
        done: Promise.resolve(),
      }),
    } as unknown as IDBPDatabase<UploadQueueDB>;
    const dedup = new ContentHashDedup(fakeDb);

    await dedup.deleteByPhotoId('album-a', 'photo-a');

    expect(records).toEqual([
      { albumId: 'album-a', contentHash: 'b'.repeat(64), photoId: 'photo-b', dateAdded: 2 },
      { albumId: 'album-b', contentHash: 'a'.repeat(64), photoId: 'photo-a', dateAdded: 3 },
    ]);
  });

  it('adds the album-photo secondary index during schema upgrades', () => {
    const createdIndexes: string[] = [];
    const store = {
      indexNames: {
        contains: (name: string) => createdIndexes.includes(name),
      } as DOMStringList,
      createIndex: (name: string) => {
        createdIndexes.push(name);
      },
    };
    const db = {
      objectStoreNames: {
        contains: (name: string) => name === ALBUM_CONTENT_HASHES_STORE || name === 'tasks',
      },
    } as unknown as IDBDatabase;

    ensureContentHashStores(db, store);

    expect(createdIndexes).toContain('album-photo');
  });

  it('usePhotoActions.deletePhoto clears dedup after server delete succeeds', async () => {
    vi.spyOn(ContentHashDedup.prototype, 'deleteByPhotoId').mockImplementation(dedupMocks.deleteByPhotoId);
    const hook = await renderPhotoActionsHook();

    await act(async () => {
      await hook.result().deletePhoto('photo-a', 'album-a');
    });

    expect(apiMocks.deleteManifest).toHaveBeenCalled();
    expect(apiMocks.deleteManifest.mock.calls[0]?.[0]).toBe('photo-a');
    expect(dedupMocks.deleteByPhotoId).toHaveBeenCalledWith('album-a', 'photo-a');
    expect(dbMocks.deleteManifest).toHaveBeenCalledWith('photo-a');
    await hook.unmount();
  });

  it('usePhotoActions.deletePhotos clears dedup for each successful deletion', async () => {
    vi.spyOn(ContentHashDedup.prototype, 'deleteByPhotoId').mockImplementation(dedupMocks.deleteByPhotoId);
    const hook = await renderPhotoActionsHook();

    let result: Awaited<ReturnType<HookResult['deletePhotos']>> | null = null;
    await act(async () => {
      result = await hook.result().deletePhotos(['photo-a', 'photo-b'], 'album-a');
    });

    expect(result).toMatchObject({ successCount: 2, failureCount: 0 });
    expect(dedupMocks.deleteByPhotoId).toHaveBeenNthCalledWith(1, 'album-a', 'photo-a');
    expect(dedupMocks.deleteByPhotoId).toHaveBeenNthCalledWith(2, 'album-a', 'photo-b');
    await hook.unmount();
  });
});
