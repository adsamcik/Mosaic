import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

const { openLightbox, useLightboxMock, unsortedPhotos } = vi.hoisted(() => {
  const openLightbox = vi.fn();
  const useLightboxMock = vi.fn(() => ({
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
  }));

  const unsortedPhotos: PhotoMeta[] = [
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
      lat: 50,
      lng: 14,
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
      lat: 51,
      lng: 15,
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
      lat: 52,
      lng: 16,
      createdAt: '2024-02-01T00:00:00Z',
      updatedAt: '2024-02-01T00:00:00Z',
      tags: [],
    },
  ];

  return { openLightbox, useLightboxMock, unsortedPhotos };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../src/contexts/AlbumContentContext', () => ({
  AlbumContentProvider: ({ children }: { children: ReactNode }) => children,
  useAlbumContent: vi.fn(() => ({
    albumId: 'album-1',
    loadState: 'idle',
    saveState: 'idle',
    document: null,
    isDirty: false,
    canEdit: true,
    loadContent: vi.fn(),
    updateBlock: vi.fn(),
    addBlock: vi.fn(),
    removeBlock: vi.fn(),
    moveBlock: vi.fn(),
    saveContent: vi.fn(),
    createInitialContent: vi.fn(),
    errorMessage: null,
  })),
}));

vi.mock('../src/contexts/AlbumPermissionsContext', () => ({
  AlbumPermissionsProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../src/contexts/UploadContext', () => ({
  UploadProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../src/contexts/SyncContext', () => ({
  useAutoSync: vi.fn(),
}));

vi.mock('../src/lib/sync-coordinator', () => ({
  SyncCoordinatorProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../src/hooks/useAlbumMembers', () => ({
  useAlbumMembers: vi.fn(() => ({
    currentUserRole: 'owner',
    isOwner: true,
    canEdit: true,
  })),
}));

vi.mock('../src/hooks/useEpochKeys', () => ({
  useAlbumEpochKeys: vi.fn(() => ({
    epochKeys: new Map([[1, new Uint8Array(32)]]),
    isLoading: false,
  })),
}));

vi.mock('../src/hooks/useLightbox', () => ({
  useLightbox: useLightboxMock,
}));

vi.mock('../src/hooks/usePhotoActions', () => ({
  usePhotoActions: vi.fn(() => ({
    deletePhotos: vi.fn().mockResolvedValue({
      failureCount: 0,
      errors: [],
    }),
    isDeleting: false,
  })),
}));

vi.mock('../src/hooks/useAlbumDownload', () => ({
  useAlbumDownload: vi.fn(() => ({
    startDownload: vi.fn().mockResolvedValue(undefined),
    isDownloading: false,
    progress: null,
  })),
}));

vi.mock('../src/hooks/usePhotoList', () => ({
  usePhotoList: vi.fn(() => ({
    photos: unsortedPhotos,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

vi.mock('../src/hooks/useSelection', () => ({
  useSelection: vi.fn(() => ({
    isSelectionMode: false,
    selectedCount: 0,
    selectedIds: new Set<string>(),
    toggleSelectionMode: vi.fn(),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    exitSelectionMode: vi.fn(),
  })),
}));

vi.mock('../src/hooks/useSync', () => ({
  useSync: vi.fn(() => ({
    syncAlbum: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => ({
    getAlbum: vi.fn(),
  })),
}));

vi.mock('../src/components/Shared/Dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../src/components/Albums', () => ({
  DeleteAlbumDialog: () => null,
  RenameAlbumDialog: () => null,
  AlbumExpirationSettings: () => null,
}));

vi.mock('../src/components/Content', () => ({
  ContentEditor: () => null,
}));

vi.mock('../src/components/Members/MemberList', () => ({
  MemberList: () => null,
}));

vi.mock('../src/components/ShareLinks/ShareLinksPanel', () => ({
  ShareLinksPanel: () => null,
}));

vi.mock('../src/components/Upload/DropZone', () => ({
  DropZone: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

vi.mock('../src/components/Upload/UploadErrorToast', () => ({
  UploadErrorToast: () => null,
}));

vi.mock('../src/components/Gallery/DeletePhotoDialog', () => ({
  DeletePhotoDialog: () => null,
}));

vi.mock('../src/components/Gallery/DownloadProgressOverlay', () => ({
  DownloadProgressOverlay: () => null,
}));

vi.mock('../src/components/Gallery/GalleryHeader', () => ({
  GalleryHeader: ({
    onViewModeChange,
  }: {
    onViewModeChange: (mode: 'grid' | 'justified' | 'mosaic' | 'map' | 'story') => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="view-toggle-map"
        onClick={() => onViewModeChange('map')}
      >
        map
      </button>
    </div>
  ),
}));

vi.mock('../src/components/Gallery/MapView', () => ({
  MapView: ({
    photos,
    onPhotoClick,
    onClusterClick,
  }: {
    photos?: PhotoMeta[];
    onPhotoClick?: (photoId: string) => void;
    onClusterClick?: (photoIds: string[]) => void;
  }) => (
    <div
      data-testid="map-view"
      data-photo-order={photos?.map((photo) => photo.id).join(',')}
    >
      <button
        type="button"
        data-testid="map-photo-open"
        onClick={() => onPhotoClick?.('photo-newest')}
      >
        open photo
      </button>
      <button
        type="button"
        data-testid="map-cluster-open"
        onClick={() => onClusterClick?.(['photo-oldest'])}
      >
        open cluster
      </button>
    </div>
  ),
}));

vi.mock('../src/components/Gallery/MosaicPhotoGrid', () => ({
  MosaicPhotoGrid: () => null,
}));

vi.mock('../src/components/Gallery/PhotoGrid', () => ({
  PhotoGrid: () => null,
}));

vi.mock('../src/components/Gallery/PhotoLightbox', () => ({
  PhotoLightbox: () => null,
}));

vi.mock('../src/components/Gallery/SelectionActionBar', () => ({
  SelectionActionBar: () => null,
}));

vi.mock('../src/components/Gallery/SquarePhotoGrid', () => ({
  SquarePhotoGrid: () => null,
}));

import { Gallery } from '../src/components/Gallery/Gallery';

describe('Gallery ordering', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  function renderGallery() {
    act(() => {
      root = createRoot(container);
      root.render(createElement(Gallery, { albumId: 'album-1' }));
    });
  }

  it('initializes the lightbox with photos sorted by visual order', () => {
    renderGallery();

    const sortedIds = useLightboxMock.mock.calls[0]?.[0].map(
      (photo: PhotoMeta) => photo.id,
    );

    expect(sortedIds).toEqual([
      'photo-newest',
      'photo-middle',
      'photo-oldest',
    ]);
  });

  it('uses the sorted photo order for map clicks and clusters', () => {
    renderGallery();

    act(() => {
      (
        container.querySelector('[data-testid="view-toggle-map"]') as HTMLButtonElement
      ).click();
    });

    const mapView = container.querySelector('[data-testid="map-view"]');
    expect(mapView?.getAttribute('data-photo-order')).toBe(
      'photo-newest,photo-middle,photo-oldest',
    );

    act(() => {
      (
        container.querySelector('[data-testid="map-photo-open"]') as HTMLButtonElement
      ).click();
    });

    expect(openLightbox).toHaveBeenCalledWith(0);

    act(() => {
      (
        container.querySelector(
          '[data-testid="map-cluster-open"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(openLightbox).toHaveBeenLastCalledWith(2);
  });
});
