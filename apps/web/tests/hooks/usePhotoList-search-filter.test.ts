/**
 * usePhotoList — search filter behavior
 *
 * Regression test for v1.0.1 release blocker
 * `validation-final-gate-isolated-v3-02`:
 *
 *   gallery-search.spec.ts:85 "clearing search restores all photos"
 *
 * Root cause: `mergedPhotos` always concatenated `pendingItems` regardless
 * of the active search query. Pending photos have no FTS5 entries and use
 * a placeholder filename (`'Uploading...'`), so they cannot legitimately
 * match a user query but were leaking into search results. On slower
 * runners (mobile-chrome) where a recently-uploaded photo was still in
 * `syncing` status when the user typed a search term, this produced
 * stale matches (e.g. count=1 when the test expected 0).
 *
 * Fix: when a non-empty search query is active, return only the DB photos
 * (which were already filtered by FTS5). Without a query, the merge
 * behavior is preserved.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ----------------------------------------------------------------

vi.mock('../../src/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/lib/db-client', () => ({
  getDbClient: vi.fn(),
}));

const loadAllAlbumPhotosMock = vi.fn();
const searchAllAlbumPhotosMock = vi.fn();

vi.mock('../../src/lib/photo-query-pagination', () => ({
  loadAllAlbumPhotos: (...args: unknown[]) => loadAllAlbumPhotosMock(...args),
  searchAllAlbumPhotos: (...args: unknown[]) => searchAllAlbumPhotosMock(...args),
}));

vi.mock('../../src/lib/sync-engine', () => ({
  syncEngine: {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
}));

// --- Imports (after mocks) ------------------------------------------------

import { usePhotoList } from '../../src/hooks/usePhotoList';
import { usePhotoStore } from '../../src/stores/photo-store';
import type { PhotoMeta } from '../../src/workers/types';

// --- Test harness ---------------------------------------------------------

interface HarnessProps {
  albumId: string;
  searchQuery: string;
  onResult: (photos: PhotoMeta[], isLoading: boolean) => void;
}

function TestHarness({ albumId, searchQuery, onResult }: HarnessProps) {
  const { photos, isLoading } = usePhotoList(albumId, searchQuery);
  onResult(photos, isLoading);
  return null;
}

function makePhoto(id: string, filename: string): PhotoMeta {
  return {
    id,
    assetId: id,
    albumId: 'album-1',
    filename,
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shardIds: [],
    epochId: 1,
  };
}

describe('usePhotoList — search filter excludes pending items', () => {
  let container: HTMLElement;
  let root: Root;
  let lastPhotos: PhotoMeta[] = [];
  let lastLoading = true;

  beforeEach(() => {
    usePhotoStore.setState({
      albums: new Map(),
      activeAlbumId: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    lastPhotos = [];
    lastLoading = true;
    loadAllAlbumPhotosMock.mockReset();
    searchAllAlbumPhotosMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  async function render(albumId: string, searchQuery: string) {
    await act(async () => {
      root.render(
        createElement(TestHarness, {
          albumId,
          searchQuery,
          onResult: (photos, isLoading) => {
            lastPhotos = photos;
            lastLoading = isLoading;
          },
        }),
      );
    });
    // Flush microtasks for async fetch
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function rerender(albumId: string, searchQuery: string) {
    await render(albumId, searchQuery);
  }

  it('includes pending photos when no search query is active', async () => {
    loadAllAlbumPhotosMock.mockResolvedValue([makePhoto('p1', 'alpha.png')]);

    // Seed a pending upload in the store
    usePhotoStore.setState((state) => {
      state.albums.set('album-1', {
        items: new Map([
          [
            'pending-asset',
            {
              assetId: 'pending-asset',
              albumId: 'album-1',
              status: 'pending',
              localBlobUrl: 'blob:fake',
              uploadProgress: 50,
              uploadAction: 'uploading',
              createdAt: new Date(),
            },
          ],
        ]),
        fetchStatus: 'idle',
        fetchError: undefined,
        hasMore: false,
        cursor: undefined,
      });
      return state;
    });

    await render('album-1', '');

    expect(lastLoading).toBe(false);
    // 1 DB photo + 1 pending = 2 entries
    expect(lastPhotos).toHaveLength(2);
    expect(lastPhotos.some((p) => p.isPending === true)).toBe(true);
  });

  it('excludes pending photos when a search query is active', async () => {
    // FTS5 returns no matches for "zzz"
    searchAllAlbumPhotosMock.mockResolvedValue([]);
    loadAllAlbumPhotosMock.mockResolvedValue([makePhoto('p1', 'alpha.png')]);

    // Seed a pending upload (e.g. still syncing)
    usePhotoStore.setState((state) => {
      state.albums.set('album-1', {
        items: new Map([
          [
            'pending-asset',
            {
              assetId: 'pending-asset',
              albumId: 'album-1',
              status: 'syncing',
              localBlobUrl: 'blob:fake',
              uploadProgress: 100,
              uploadAction: 'finalizing',
              createdAt: new Date(),
            },
          ],
        ]),
        fetchStatus: 'idle',
        fetchError: undefined,
        hasMore: false,
        cursor: undefined,
      });
      return state;
    });

    await render('album-1', 'zzz-nonexistent-xyz');

    expect(lastLoading).toBe(false);
    expect(searchAllAlbumPhotosMock).toHaveBeenCalled();
    // Pending photo must NOT leak into the filtered view.
    expect(lastPhotos).toHaveLength(0);
  });

  it('restores DB photos (and pending) after clearing an active search', async () => {
    searchAllAlbumPhotosMock.mockResolvedValue([]);
    loadAllAlbumPhotosMock.mockResolvedValue([
      makePhoto('p1', 'alpha.png'),
      makePhoto('p2', 'bravo.png'),
    ]);

    // Seed a syncing pending photo
    usePhotoStore.setState((state) => {
      state.albums.set('album-1', {
        items: new Map([
          [
            'pending-asset',
            {
              assetId: 'pending-asset',
              albumId: 'album-1',
              status: 'syncing',
              localBlobUrl: 'blob:fake',
              uploadProgress: 100,
              uploadAction: 'finalizing',
              createdAt: new Date(),
            },
          ],
        ]),
        fetchStatus: 'idle',
        fetchError: undefined,
        hasMore: false,
        cursor: undefined,
      });
      return state;
    });

    // Active search → 0 matches (pending suppressed)
    await render('album-1', 'zzz');
    expect(lastPhotos).toHaveLength(0);

    // User clears the search → all photos restored, including the pending one
    await rerender('album-1', '');
    expect(lastPhotos.length).toBeGreaterThanOrEqual(2);
    // The two DB photos must be present
    const filenames = lastPhotos.map((p) => p.filename);
    expect(filenames).toContain('alpha.png');
    expect(filenames).toContain('bravo.png');
  });
});
