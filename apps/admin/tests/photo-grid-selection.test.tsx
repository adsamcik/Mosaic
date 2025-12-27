/**
 * PhotoGrid Selection and Delete Tests
 *
 * Tests for selection mode and delete functionality in PhotoGrid.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

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

  const render = (albumId = 'album-1') => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(PhotoGrid, { albumId }));
    });

    return {
      getByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`),
      getAllByTestId: (id: string) => container.querySelectorAll(`[data-testid="${id}"]`),
      queryByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`),
    };
  };

  describe('toolbar', () => {
    it('renders selection mode button', () => {
      const { getByTestId } = render();
      expect(getByTestId('selection-mode-button')).toBeTruthy();
    });

    it('toggles selection mode when button is clicked', () => {
      const { getByTestId } = render();
      
      const button = getByTestId('selection-mode-button');
      expect(button?.textContent).toBe('Select');

      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(button?.textContent).toBe('Cancel');
    });

    it('shows select all button in selection mode', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Not visible before selection mode
      expect(queryByTestId('select-all-button')).toBeNull();

      // Enter selection mode
      const button = getByTestId('selection-mode-button');
      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(getByTestId('select-all-button')).toBeTruthy();
    });

    it('shows selection count when photos are selected', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Enter selection mode
      const selectButton = getByTestId('selection-mode-button');
      act(() => {
        selectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // No count initially
      expect(queryByTestId('selection-count')).toBeNull();

      // Select all
      const selectAllButton = getByTestId('select-all-button');
      act(() => {
        selectAllButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const count = getByTestId('selection-count');
      expect(count?.textContent).toContain('3 selected');
    });

    it('shows bulk delete button when photos are selected', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Enter selection mode
      const selectButton = getByTestId('selection-mode-button');
      act(() => {
        selectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // No delete button initially
      expect(queryByTestId('bulk-delete-button')).toBeNull();

      // Select all
      const selectAllButton = getByTestId('select-all-button');
      act(() => {
        selectAllButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const deleteButton = getByTestId('bulk-delete-button');
      expect(deleteButton).toBeTruthy();
      expect(deleteButton?.textContent).toContain('Delete (3)');
    });

    it('clears selection when clear button is clicked', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Enter selection mode
      act(() => {
        getByTestId('selection-mode-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Select all
      act(() => {
        getByTestId('select-all-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(getByTestId('selection-count')).toBeTruthy();

      // Clear selection
      act(() => {
        getByTestId('clear-selection-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(queryByTestId('selection-count')).toBeNull();
    });

    it('clears selection when exiting selection mode', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Enter selection mode and select all
      act(() => {
        getByTestId('selection-mode-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      act(() => {
        getByTestId('select-all-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(getByTestId('selection-count')).toBeTruthy();

      // Exit selection mode
      act(() => {
        getByTestId('selection-mode-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Selection should be cleared and count hidden
      expect(queryByTestId('selection-count')).toBeNull();
      expect(queryByTestId('select-all-button')).toBeNull();
    });
  });

  describe('delete dialog', () => {
    it('opens delete dialog when bulk delete button is clicked', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Enter selection mode and select all
      act(() => {
        getByTestId('selection-mode-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      act(() => {
        getByTestId('select-all-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Click delete
      act(() => {
        getByTestId('bulk-delete-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(getByTestId('delete-photo-dialog')).toBeTruthy();
    });

    it('closes delete dialog when cancel is clicked', () => {
      const { getByTestId, queryByTestId } = render();
      
      // Enter selection mode and select all
      act(() => {
        getByTestId('selection-mode-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      act(() => {
        getByTestId('select-all-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Click delete to open dialog
      act(() => {
        getByTestId('bulk-delete-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(getByTestId('delete-photo-dialog')).toBeTruthy();

      // Click cancel
      act(() => {
        getByTestId('delete-cancel-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(queryByTestId('delete-photo-dialog')).toBeNull();
    });
  });

  describe('grid rendering', () => {
    it('renders photo grid container', () => {
      const { getByTestId } = render();
      
      expect(getByTestId('photo-grid')).toBeTruthy();
      // Note: Due to virtualization, thumbnails only render when there's a viewport
      // The toolbar and grid container should always be present
    });

    it('renders toolbar above grid', () => {
      const { getByTestId } = render();
      
      const toolbar = getByTestId('photo-grid-toolbar');
      const grid = getByTestId('photo-grid');

      expect(toolbar).toBeTruthy();
      expect(grid).toBeTruthy();

      // Toolbar should come before grid in DOM
      const toolbarPosition = toolbar?.compareDocumentPosition(grid!);
      expect(toolbarPosition).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
  });
});
