import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

const openLightbox = vi.fn();
const handleSelectionChange = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: `row-${index}`,
        index,
        start: index * 100,
        size: 100,
      })),
  })),
}));

vi.mock('../src/hooks/useEpochKeys', () => ({
  useAlbumEpochKeys: vi.fn(() => ({
    epochKeys: new Map([[1, new Uint8Array(32)]]),
    isLoading: false,
  })),
}));

vi.mock('../src/hooks/useLightbox', () => ({
  useLightbox: vi.fn(() => ({
    isOpen: false,
    currentPhoto: null,
    currentIndex: 0,
    hasNext: false,
    hasPrevious: false,
    navigationDirection: 'initial',
    open: openLightbox,
    close: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    goTo: vi.fn(),
  })),
}));

vi.mock('../src/hooks/useLightboxPreload', () => ({
  useLightboxPreload: vi.fn(() => []),
}));

vi.mock('../src/hooks/usePhotoDelete', () => ({
  usePhotoDelete: vi.fn(() => ({
    deleteTarget: null,
    deleteThumbnailUrl: undefined,
    isDeleting: false,
    error: null,
    handleDeletePhoto: vi.fn(),
    handleDeleteFromLightbox: vi.fn(),
    handleConfirmDelete: vi.fn(),
    handleCancelDelete: vi.fn(),
  })),
}));

vi.mock('../src/hooks/useGridSelection', () => ({
  useGridSelection: vi.fn(() => handleSelectionChange),
}));

vi.mock('../src/stores/photo-store', () => ({
  usePhotoStore: vi.fn((selector: (state: { getPhoto: () => undefined }) => unknown) =>
    selector({ getPhoto: () => undefined }),
  ),
}));

vi.mock('../src/components/Gallery/PhotoThumbnail', () => ({
  PhotoThumbnail: ({
    photo,
    onClick,
  }: {
    photo: PhotoMeta;
    onClick: () => void;
  }) => (
    <button
      type="button"
      data-testid="photo-thumbnail"
      data-photo-id={photo.id}
      onClick={onClick}
    >
      {photo.filename}
    </button>
  ),
}));

vi.mock('../src/components/Gallery/DeletePhotoDialog', () => ({
  DeletePhotoDialog: () => null,
}));

vi.mock('../src/components/Gallery/PhotoLightbox', () => ({
  PhotoLightbox: () => null,
}));

import { SquarePhotoGrid } from '../src/components/Gallery/SquarePhotoGrid';

const photos: PhotoMeta[] = [
  {
    id: 'photo-oldest',
    assetId: 'asset-oldest',
    albumId: 'album-1',
    filename: 'oldest.jpg',
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    shardIds: ['shard-oldest'],
    epochId: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'photo-newest',
    assetId: 'asset-newest',
    albumId: 'album-1',
    filename: 'newest.jpg',
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    shardIds: ['shard-newest'],
    epochId: 1,
    createdAt: '2024-03-01T00:00:00Z',
    updatedAt: '2024-03-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'photo-middle',
    assetId: 'asset-middle',
    albumId: 'album-1',
    filename: 'middle.jpg',
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    shardIds: ['shard-middle'],
    epochId: 1,
    createdAt: '2024-02-01T00:00:00Z',
    updatedAt: '2024-02-01T00:00:00Z',
    tags: [],
  },
];

describe('SquarePhotoGrid ordering', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const resizeObserverInstances: Array<{
    callback: ResizeObserverCallback;
  }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);

    class MockResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeObserverInstances.push({ callback });
      }

      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: {
                width: 800,
                height: 600,
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                bottom: 600,
                right: 800,
                toJSON: () => ({}),
              },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }

      disconnect() {}

      unobserve() {}
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders and opens photos using sorted visual order', () => {
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(SquarePhotoGrid, {
          albumId: 'album-1',
          photos,
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      );
    });

    const renderedIds = Array.from(
      container.querySelectorAll('[data-testid="photo-thumbnail"]'),
    ).map((element) => element.getAttribute('data-photo-id'));

    expect(renderedIds).toEqual([
      'photo-newest',
      'photo-middle',
      'photo-oldest',
    ]);

    act(() => {
      (
        container.querySelector('[data-testid="photo-thumbnail"]') as HTMLButtonElement
      ).click();
    });

    expect(openLightbox).toHaveBeenCalledWith(0);
  });
});
