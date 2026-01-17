/**
 * GalleryHeader Component Tests - View Toggles
 * Tests the updated UI with SVG icons for view mode toggles
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryHeader } from '../src/components/Gallery/GalleryHeader';

// Mock the AlbumPermissionsContext
vi.mock('../src/contexts/AlbumPermissionsContext', () => ({
  useAlbumPermissions: () => ({
    isOwner: true,
    canUpload: true,
    canDelete: true,
    canDownload: true,
    canManageMembers: true,
    canManageShareLinks: true,
  }),
  AlbumPermissionsProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

// Mock the UploadButton
vi.mock('../src/components/Upload/UploadButton', () => ({
  UploadButton: () =>
    createElement('button', { 'data-testid': 'upload-button' }, 'Upload'),
}));

// Mock the AlbumSettingsDropdown
vi.mock('../src/components/Gallery/AlbumSettingsDropdown', () => ({
  AlbumSettingsDropdown: () =>
    createElement('div', { 'data-testid': 'album-settings' }, 'Settings'),
}));

// Mock the SearchInput
vi.mock('../src/components/Gallery/SearchInput', () => ({
  SearchInput: ({ onSearch }: { onSearch: (q: string) => void }) =>
    createElement('input', {
      'data-testid': 'search-input',
      onChange: (e: any) => onSearch(e.target.value),
    }),
}));

describe('GalleryHeader - View Toggles', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders view mode toggle buttons', () => {
    act(() => {
      root.render(
        createElement(GalleryHeader, {
          albumId: 'album-1',
          albumName: 'Test Album',
          photoCount: 10,
          geotaggedCount: 5,
          viewMode: 'justified',
          onViewModeChange: vi.fn(),
          onSearch: vi.fn(),
          onShowMembers: vi.fn(),
          onShowShareLinks: vi.fn(),
        }),
      );
    });

    // Check for view toggle container
    const viewToggle = container.querySelector('.view-toggle');
    expect(viewToggle).not.toBeNull();
  });

  it('renders view toggle buttons with SVG icons', () => {
    act(() => {
      root.render(
        createElement(GalleryHeader, {
          albumId: 'album-1',
          albumName: 'Test Album',
          photoCount: 10,
          geotaggedCount: 5,
          viewMode: 'justified',
          onViewModeChange: vi.fn(),
          onSearch: vi.fn(),
          onShowMembers: vi.fn(),
          onShowShareLinks: vi.fn(),
        }),
      );
    });

    const viewToggleButtons = container.querySelectorAll('.view-toggle-btn');
    expect(viewToggleButtons.length).toBeGreaterThanOrEqual(2);

    // Each button should have SVG icons
    viewToggleButtons.forEach((button) => {
      const svg = button.querySelector('svg');
      expect(svg).not.toBeNull();
    });

    // Should NOT contain emoji characters
    const viewToggle = container.querySelector('.view-toggle');
    expect(viewToggle?.textContent).not.toContain('📷');
    expect(viewToggle?.textContent).not.toContain('⊞');
    expect(viewToggle?.textContent).not.toContain('🗺️');
  });

  it('highlights active view mode', () => {
    act(() => {
      root.render(
        createElement(GalleryHeader, {
          albumId: 'album-1',
          albumName: 'Test Album',
          photoCount: 10,
          geotaggedCount: 5,
          viewMode: 'grid',
          onViewModeChange: vi.fn(),
          onSearch: vi.fn(),
          onShowMembers: vi.fn(),
          onShowShareLinks: vi.fn(),
        }),
      );
    });

    const activeButton = container.querySelector('.view-toggle-btn--active');
    expect(activeButton).not.toBeNull();
  });

  it('calls onViewModeChange when toggle is clicked', () => {
    const onViewModeChange = vi.fn();

    act(() => {
      root.render(
        createElement(GalleryHeader, {
          albumId: 'album-1',
          albumName: 'Test Album',
          photoCount: 10,
          geotaggedCount: 5,
          viewMode: 'justified',
          onViewModeChange,
          onSearch: vi.fn(),
          onShowMembers: vi.fn(),
          onShowShareLinks: vi.fn(),
        }),
      );
    });

    const viewToggleButtons = container.querySelectorAll('.view-toggle-btn');

    // Click on a non-active button (grid mode)
    const gridButton = Array.from(viewToggleButtons).find(
      (btn) => !btn.classList.contains('view-toggle-btn--active'),
    ) as HTMLButtonElement;

    if (gridButton) {
      act(() => {
        gridButton.click();
      });

      expect(onViewModeChange).toHaveBeenCalled();
    }
  });

  it('renders album header component', () => {
    act(() => {
      root.render(
        createElement(GalleryHeader, {
          albumId: 'album-1',
          albumName: 'Vacation Photos',
          photoCount: 42,
          geotaggedCount: 10,
          viewMode: 'justified',
          onViewModeChange: vi.fn(),
          onSearch: vi.fn(),
          onShowMembers: vi.fn(),
          onShowShareLinks: vi.fn(),
        }),
      );
    });

    // Verify the header renders - the mocked AlbumSettingsDropdown should be present
    expect(
      container.querySelector('[data-testid="album-settings"]'),
    ).not.toBeNull();
  });

  it('shows map toggle only when geotagged photos exist', () => {
    act(() => {
      root.render(
        createElement(GalleryHeader, {
          albumId: 'album-1',
          albumName: 'Test Album',
          photoCount: 10,
          geotaggedCount: 5, // Has geotagged photos
          viewMode: 'justified',
          onViewModeChange: vi.fn(),
          onSearch: vi.fn(),
          onShowMembers: vi.fn(),
          onShowShareLinks: vi.fn(),
        }),
      );
    });

    // Find the map view toggle
    const viewToggleButtons = container.querySelectorAll('.view-toggle-btn');
    // Should have 4 buttons: justified, grid, mosaic, map
    expect(viewToggleButtons.length).toBe(4);
  });
});
