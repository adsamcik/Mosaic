/**
 * Gallery Component Tests
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../src/components/Gallery/Gallery';
import type { PhotoMeta } from '../src/workers/types';

// Mock Leaflet for MapView
const mockMap = {
  setView: vi.fn().mockReturnThis(),
  remove: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  getBounds: vi.fn(() => ({
    getWest: () => -180,
    getSouth: () => -90,
    getEast: () => 180,
    getNorth: () => 90,
  })),
  getZoom: vi.fn(() => 5),
  fitBounds: vi.fn(),
};

vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => mockMap),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    layerGroup: vi.fn(() => ({ addTo: vi.fn(), addLayer: vi.fn(), clearLayers: vi.fn() })),
    marker: vi.fn(() => ({ on: vi.fn().mockReturnThis(), bindTooltip: vi.fn().mockReturnThis() })),
    divIcon: vi.fn((opts) => opts),
    latLng: vi.fn((lat, lng) => ({ lat, lng })),
    latLngBounds: vi.fn(),
    control: { zoom: vi.fn(() => ({ addTo: vi.fn() })) },
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
  },
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet/dist/images/marker-icon-2x.png', () => ({ default: '' }));
vi.mock('leaflet/dist/images/marker-icon.png', () => ({ default: '' }));
vi.mock('leaflet/dist/images/marker-shadow.png', () => ({ default: '' }));

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
    lat: 40.7128,
    lng: -74.006,
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
];

// Mock hooks
vi.mock('../src/hooks/usePhotos', () => ({
  usePhotos: vi.fn(() => ({
    photos: mockPhotos,
    isLoading: false,
    error: null,
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
    open: vi.fn(),
    close: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
  })),
}));

// Mock geo client
vi.mock('../src/lib/geo-client', () => ({
  getGeoClient: vi.fn(() => Promise.resolve({
    load: vi.fn(),
    getClusters: vi.fn().mockResolvedValue([]),
    getLeaves: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock db client
vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(() => Promise.resolve({
    getPhotos: vi.fn().mockResolvedValue([]),
  })),
}));

// Helper to render component and get elements
function renderGallery(props: { albumId: string } = { albumId: 'test-album-123' }) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Gallery, props));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  const queryByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  const getByText = (text: string) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes(text)) {
        return walker.currentNode.parentElement;
      }
    }
    return null;
  };

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  return {
    container,
    getByTestId,
    queryByTestId,
    getByText,
    cleanup,
    props,
  };
}

describe('Gallery', () => {
  const albumId = 'test-album-123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('View Toggle', () => {
    it('renders view toggle buttons', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const gridToggle = getByTestId('view-toggle-grid');
      const mapToggle = getByTestId('view-toggle-map');

      expect(gridToggle).not.toBeNull();
      expect(mapToggle).not.toBeNull();

      cleanup();
    });

    it('defaults to grid view', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const gridToggle = getByTestId('view-toggle-grid');
      expect(gridToggle?.className).toContain('view-toggle-btn--active');

      cleanup();
    });

    it('switches to map view when map toggle is clicked', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const mapToggle = getByTestId('view-toggle-map');
      act(() => {
        mapToggle?.click();
      });

      expect(mapToggle?.className).toContain('view-toggle-btn--active');

      // Map view should be rendered
      const mapView = getByTestId('map-view');
      expect(mapView).not.toBeNull();

      cleanup();
    });

    it('switches back to grid view when grid toggle is clicked', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      // Switch to map
      const mapToggle = getByTestId('view-toggle-map');
      act(() => {
        mapToggle?.click();
      });

      // Switch back to grid
      const gridToggle = getByTestId('view-toggle-grid');
      act(() => {
        gridToggle?.click();
      });

      expect(gridToggle?.className).toContain('view-toggle-btn--active');
      expect(getByTestId('photo-grid')).not.toBeNull();

      cleanup();
    });

    it('shows geotagged count badge on map toggle', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const mapToggle = getByTestId('view-toggle-map');
      const badge = mapToggle?.querySelector('.view-toggle-badge');

      // Should show 1 geotagged photo (only photo-1 has lat/lng)
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('1');

      cleanup();
    });

    it('sets aria-pressed attribute correctly', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const gridToggle = getByTestId('view-toggle-grid');
      const mapToggle = getByTestId('view-toggle-map');

      expect(gridToggle?.getAttribute('aria-pressed')).toBe('true');
      expect(mapToggle?.getAttribute('aria-pressed')).toBe('false');

      act(() => {
        mapToggle?.click();
      });

      expect(gridToggle?.getAttribute('aria-pressed')).toBe('false');
      expect(mapToggle?.getAttribute('aria-pressed')).toBe('true');

      cleanup();
    });
  });

  describe('Gallery Header', () => {
    it('renders gallery title', () => {
      const { getByText, cleanup } = renderGallery({ albumId });

      const title = getByText('Photos');
      expect(title).not.toBeNull();

      cleanup();
    });

    it('renders share button', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const shareButton = getByTestId('share-button');
      expect(shareButton).not.toBeNull();

      cleanup();
    });

    it('renders upload button', () => {
      const { getByText, cleanup } = renderGallery({ albumId });

      const uploadButton = getByText('Upload');
      expect(uploadButton).not.toBeNull();

      cleanup();
    });
  });

  describe('Loading State', () => {
    it('shows loading state when photos are loading', async () => {
      const { usePhotos } = await import('../src/hooks/usePhotos');
      vi.mocked(usePhotos).mockReturnValueOnce({
        photos: [],
        isLoading: true,
        error: null,
      });

      const { getByText, cleanup } = renderGallery({ albumId });

      expect(getByText('Loading photos...')).not.toBeNull();

      cleanup();
    });
  });

  describe('Error State', () => {
    it('shows error state when loading fails', async () => {
      const { usePhotos } = await import('../src/hooks/usePhotos');
      vi.mocked(usePhotos).mockReturnValue({
        photos: [],
        isLoading: false,
        error: new Error('Network error'),
      });

      const { container, cleanup } = renderGallery({ albumId });

      // Check that error message exists in the rendered content
      expect(container.textContent).toContain('Failed to load photos');

      cleanup();

      // Reset the mock for other tests
      vi.mocked(usePhotos).mockReturnValue({
        photos: mockPhotos,
        isLoading: false,
        error: null,
      });
    });
  });

  describe('Map View Integration', () => {
    it('passes geotagged photos to MapView', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      // Switch to map view
      const mapToggle = getByTestId('view-toggle-map');
      act(() => {
        mapToggle?.click();
      });

      const mapView = getByTestId('map-view');
      // Only photo-1 has lat/lng, so 1 point
      expect(mapView?.getAttribute('data-point-count')).toBe('1');

      cleanup();
    });

    it('passes photo metadata to MapView for thumbnails', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      // Switch to map view
      const mapToggle = getByTestId('view-toggle-map');
      act(() => {
        mapToggle?.click();
      });

      // Map view should render without error
      expect(getByTestId('map-view')).not.toBeNull();

      cleanup();
    });
  });

  describe('Member List', () => {
    it('opens member list when share button is clicked', () => {
      const { getByTestId, cleanup } = renderGallery({ albumId });

      const shareButton = getByTestId('share-button');
      act(() => {
        shareButton?.click();
      });

      // Member panel should be visible
      const memberPanel = getByTestId('member-panel');
      expect(memberPanel).not.toBeNull();

      cleanup();
    });
  });
});

describe('photosToGeoFeatures', () => {
  it('filters out photos without coordinates', () => {
    // This is tested indirectly through the Gallery component
    // Only photos with lat/lng should appear in the map
    const { getByTestId, cleanup } = renderGallery({ albumId: 'test' });

    const mapToggle = getByTestId('view-toggle-map');
    act(() => {
      mapToggle?.click();
    });

    const mapView = getByTestId('map-view');
    // mockPhotos has 2 photos but only 1 with coordinates
    expect(mapView?.getAttribute('data-point-count')).toBe('1');

    cleanup();
  });
});
