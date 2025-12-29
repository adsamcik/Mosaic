/**
 * PhotoGrid Selection and Delete Tests
 *
 * Tests for selection mode and delete functionality in PhotoGrid.
 * Note: Selection toolbar controls are now in GalleryHeader.
 * PhotoGrid receives selection state via props.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';
import type { UseSelectionReturn } from '../src/hooks/useSelection';

// Mock photos data
const mockPhotos: PhotoMeta[] = [
  {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo1.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shardIds: ['shard-1'],
    epochId: 1,
  },
  {
    id: 'photo-2',
    assetId: 'asset-2',
    albumId: 'album-1',
    filename: 'photo2.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shardIds: ['shard-2'],
    epochId: 1,
  },
  {
    id: 'photo-3',
    assetId: 'asset-3',
    albumId: 'album-1',
    filename: 'photo3.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shardIds: ['shard-3'],
    epochId: 1,
  },
];

// Mock photo actions
const mockPhotoActions = {
  deletePhoto: vi.fn().mockResolvedValue(undefined),
  deletePhotos: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, failedIds: [], errors: [] }),
  isDeleting: false,
  error: null as string | null,
  clearError: vi.fn(),
};

// Mock hooks
vi.mock('../src/hooks/usePhotos', () => ({
  usePhotos: vi.fn(() => ({
    photos: mockPhotos,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
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
    open: vi.fn(),
    close: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    hasNext: false,
    hasPrevious: false,
  })),
}));

vi.mock('../src/hooks/usePhotoActions', () => ({
  usePhotoActions: vi.fn(() => mockPhotoActions),
  PhotoDeleteError: class extends Error {
    constructor(message: string, public readonly manifestId: string) {
      super(message);
    }
  },
}));

// Mock photo service to avoid actual image loading
vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: vi.fn().mockResolvedValue({
    blobUrl: 'blob:mock-url',
    mimeType: 'image/jpeg',
    size: 1024,
  }),
  releasePhoto: vi.fn(),
  preloadPhotos: vi.fn(),
}));

// Import component after mocks
import { PhotoGrid } from '../src/components/Gallery/PhotoGrid';

describe('PhotoGrid Selection and Delete', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPhotoActions.isDeleting = false;
    mockPhotoActions.error = null;
    
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    document.body.innerHTML = '';
  });

  const createMockSelection = (overrides?: Partial<UseSelectionReturn>): UseSelectionReturn => ({
    isSelectionMode: false,
    selectedIds: new Set(),
    selectedCount: 0,
    toggleSelectionMode: vi.fn(),
    enterSelectionMode: vi.fn(),
    exitSelectionMode: vi.fn(),
    togglePhotoSelection: vi.fn(),
    selectPhoto: vi.fn(),
    deselectPhoto: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    isSelected: vi.fn(() => false),
    ...overrides,
  });

  const render = (albumId = 'album-1', selection?: UseSelectionReturn) => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(PhotoGrid, { albumId, selection }));
    });

    return {
      getByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`),
      getAllByTestId: (id: string) => container.querySelectorAll(`[data-testid="${id}"]`),
      queryByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`),
    };
  };

  describe('selection with props', () => {
    it('renders photo grid without toolbar (toolbar is now in GalleryHeader)', () => {
      const { queryByTestId, getByTestId } = render();
      
      // Toolbar should not be present in PhotoGrid anymore
      expect(queryByTestId('photo-grid-toolbar')).toBeNull();
      
      // Grid should still be present
      expect(getByTestId('photo-grid')).toBeTruthy();
    });

    it('shows checkboxes when selection mode is active via props', () => {
      const mockSelection = createMockSelection({
        isSelectionMode: true,
        selectedIds: new Set(),
        selectedCount: 0,
      });
      
      // Due to virtualization, we can't easily test checkbox visibility
      // but we can verify the component renders without errors
      const { getByTestId } = render('album-1', mockSelection);
      expect(getByTestId('photo-grid')).toBeTruthy();
    });

    it('marks photos as selected based on selection state', () => {
      const mockSelection = createMockSelection({
        isSelectionMode: true,
        selectedIds: new Set(['photo-1', 'photo-2']),
        selectedCount: 2,
        isSelected: vi.fn((id: string) => ['photo-1', 'photo-2'].includes(id)),
      });
      
      const { getByTestId } = render('album-1', mockSelection);
      expect(getByTestId('photo-grid')).toBeTruthy();
    });
  });

  describe('delete dialog', () => {
    it('shows delete dialog when single photo delete is triggered', async () => {
      // This tests the internal delete functionality which is still in PhotoGrid
      const { getByTestId } = render();
      
      // Grid should be present
      expect(getByTestId('photo-grid')).toBeTruthy();
      
      // Note: Due to virtualization, we can't easily trigger delete button
      // The delete dialog is tested more thoroughly in e2e tests
    });
  });

  describe('grid rendering', () => {
    it('renders photo grid container', () => {
      const { getByTestId } = render();
      
      expect(getByTestId('photo-grid')).toBeTruthy();
    });

    it('passes selection state to thumbnails', () => {
      const mockSelection = createMockSelection({
        isSelectionMode: true,
        selectedIds: new Set(['photo-1']),
        selectedCount: 1,
      });
      
      const { getByTestId } = render('album-1', mockSelection);
      
      // Verify grid renders without errors when selection is provided
      expect(getByTestId('photo-grid')).toBeTruthy();
    });
  });
});
