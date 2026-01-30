/**
 * PhotoPickerDialog Tests
 *
 * Tests for the photo selection dialog component using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test photo data
const mockPhotos = [
  {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo1.jpg',
    thumbnail: 'data:image/jpeg;base64,/9j/test1',
    thumbhash: null,
    blurhash: null,
    epochId: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 0,
    mimeType: 'image/jpeg',
  },
  {
    id: 'photo-2',
    assetId: 'asset-2',
    albumId: 'album-1',
    filename: 'photo2.jpg',
    thumbnail: 'data:image/jpeg;base64,/9j/test2',
    thumbhash: null,
    blurhash: null,
    epochId: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 1,
    mimeType: 'image/jpeg',
  },
  {
    id: 'photo-3',
    assetId: 'asset-3',
    albumId: 'album-1',
    filename: 'photo3.jpg',
    thumbnail: 'data:image/jpeg;base64,/9j/test3',
    thumbhash: null,
    blurhash: null,
    epochId: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 2,
    mimeType: 'image/jpeg',
  },
];

// Control mock behavior
let mockPhotosReturn = mockPhotos;

// Mock the hooks before importing the component
vi.mock('../../src/hooks/usePhotos', () => ({
  usePhotos: () => ({
    photos: mockPhotosReturn,
    isLoading: false,
    error: null,
    refetch: () => {},
  }),
}));

vi.mock('../../src/hooks/useEpochKeys', () => ({
  useAlbumEpochKeys: () => ({
    epochKeys: new Map([[1, new Uint8Array(32)]]),
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../../src/lib/thumbhash-decoder', () => ({
  getCachedPlaceholderDataURL: () => null,
  isValidPlaceholderHash: () => false,
}));

// Mock the Dialog component to avoid its complexity  
vi.mock('../../src/components/Shared/Dialog', () => ({
  Dialog: ({ isOpen, children, footer, testId }: {
    isOpen: boolean;
    children: React.ReactNode;
    footer: React.ReactNode;
    testId: string;
  }) => {
    if (!isOpen) return null;
    return createElement('div', { 'data-testid': testId }, [
      createElement('div', { key: 'content', 'data-testid': 'dialog-content' }, children),
      createElement('div', { key: 'footer', 'data-testid': 'dialog-footer' }, footer),
    ]);
  },
}));

// Helper to render component and get container
function renderComponent<P extends object>(
  Component: React.ComponentType<P>,
  props: P,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Component, props));
  });

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  return { container, cleanup };
}

// Setup and teardown for each test
let cleanupFns: (() => void)[] = [];

beforeEach(() => {
  mockPhotosReturn = mockPhotos;
});

afterEach(() => {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
});

function render<P extends object>(Component: React.ComponentType<P>, props: P) {
  const result = renderComponent(Component, props);
  cleanupFns.push(result.cleanup);
  return result;
}

describe('PhotoPickerDialog', () => {
  it('can be imported', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    expect(PhotoPickerDialog).toBeDefined();
    expect(typeof PhotoPickerDialog).toBe('object'); // memo returns an object
  });

  it('basic render works', () => {
    // Test that basic rendering works at all
    const SimpleComponent = () => createElement('div', { 'data-testid': 'simple' }, 'Hello');
    const { container } = render(SimpleComponent, {});
    expect(container.querySelector('[data-testid="simple"]')).not.toBeNull();
  });

  it('renders nothing when closed', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: false,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    expect(container.querySelector('[data-testid="photo-picker-dialog"]')).toBeNull();
  });

  it('renders dialog when open', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    expect(container.querySelector('[data-testid="photo-picker-dialog"]')).not.toBeNull();
  });

  it('shows photos in grid when open', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    // Should show all mock photos
    const photo1 = container.querySelector('[data-testid="picker-photo-photo-1"]');
    const photo2 = container.querySelector('[data-testid="picker-photo-photo-2"]');
    const photo3 = container.querySelector('[data-testid="picker-photo-photo-3"]');
    
    expect(photo1).not.toBeNull();
    expect(photo2).not.toBeNull();
    expect(photo3).not.toBeNull();
  });

  it('shows cancel and confirm buttons', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    const cancelBtn = container.querySelector('[data-testid="photo-picker-cancel"]');
    const confirmBtn = container.querySelector('[data-testid="photo-picker-confirm"]');
    
    expect(cancelBtn).not.toBeNull();
    expect(confirmBtn).not.toBeNull();
  });

  it('confirm button is disabled when no photos selected', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    const confirmBtn = container.querySelector('[data-testid="photo-picker-confirm"]') as HTMLButtonElement;
    
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn.disabled).toBe(true);
  });

  it('selects photo when clicked', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    const photo1 = container.querySelector('[data-testid="picker-photo-photo-1"]') as HTMLElement;
    expect(photo1).not.toBeNull();
    
    // Click to select
    act(() => {
      photo1.click();
    });
    
    // Check it has selected class
    expect(photo1.classList.contains('selected')).toBe(true);
    
    // Confirm button should now be enabled
    const confirmBtn = container.querySelector('[data-testid="photo-picker-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });

  it('calls onSelect with selected photo IDs when confirmed', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const onSelect = vi.fn();
    const onClose = vi.fn();
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose,
      onSelect,
      albumId: 'album-1',
    });
    
    // Select two photos
    const photo1 = container.querySelector('[data-testid="picker-photo-photo-1"]') as HTMLElement;
    const photo2 = container.querySelector('[data-testid="picker-photo-photo-2"]') as HTMLElement;
    
    act(() => {
      photo1.click();
      photo2.click();
    });
    
    // Click confirm
    const confirmBtn = container.querySelector('[data-testid="photo-picker-confirm"]') as HTMLButtonElement;
    act(() => {
      confirmBtn.click();
    });
    
    // Should call onSelect with both photo IDs
    expect(onSelect).toHaveBeenCalledTimes(1);
    const selectedIds = onSelect.mock.calls[0][0];
    expect(selectedIds).toContain('photo-1');
    expect(selectedIds).toContain('photo-2');
    expect(selectedIds.length).toBe(2);
    
    // Should also call onClose
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when cancel clicked', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const onClose = vi.fn();
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose,
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    const cancelBtn = container.querySelector('[data-testid="photo-picker-cancel"]') as HTMLButtonElement;
    
    act(() => {
      cancelBtn.click();
    });
    
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deselects photo when clicked again', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    const photo1 = container.querySelector('[data-testid="picker-photo-photo-1"]') as HTMLElement;
    
    // Click to select
    act(() => {
      photo1.click();
    });
    expect(photo1.classList.contains('selected')).toBe(true);
    
    // Click again to deselect
    act(() => {
      photo1.click();
    });
    expect(photo1.classList.contains('selected')).toBe(false);
  });

  it('respects maxSelection limit', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
      maxSelection: 2,
    });
    
    const photo1 = container.querySelector('[data-testid="picker-photo-photo-1"]') as HTMLElement;
    const photo2 = container.querySelector('[data-testid="picker-photo-photo-2"]') as HTMLElement;
    const photo3 = container.querySelector('[data-testid="picker-photo-photo-3"]') as HTMLElement;
    
    // Select first two photos
    act(() => {
      photo1.click();
      photo2.click();
    });
    
    expect(photo1.classList.contains('selected')).toBe(true);
    expect(photo2.classList.contains('selected')).toBe(true);
    
    // Try to select third photo - should not work (max is 2)
    act(() => {
      photo3.click();
    });
    
    expect(photo3.classList.contains('selected')).toBe(false);
  });

  it('shows empty state when no photos', async () => {
    mockPhotosReturn = []; // Set to empty
    
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    // Should show empty state
    const emptyState = container.querySelector('[data-testid="photo-picker-empty"]');
    expect(emptyState).not.toBeNull();
  });

  it('shows search input', async () => {
    const { PhotoPickerDialog } = await import('../../src/components/Content/PhotoPickerDialog');
    
    const { container } = render(PhotoPickerDialog, {
      isOpen: true,
      onClose: () => {},
      onSelect: () => {},
      albumId: 'album-1',
    });
    
    const searchInput = container.querySelector('[data-testid="photo-picker-search"]');
    expect(searchInput).not.toBeNull();
  });
});

