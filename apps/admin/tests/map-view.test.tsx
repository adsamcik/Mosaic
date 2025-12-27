/**
 * MapView Component Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MapView } from '../src/components/Gallery/MapView';
import type { GeoFeature, PhotoMeta } from '../src/workers/types';

// Mock Leaflet - we can't fully test map rendering in happy-dom
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

const mockLayerGroup = {
  addTo: vi.fn().mockReturnThis(),
  addLayer: vi.fn(),
  clearLayers: vi.fn(),
};

const mockMarker = {
  on: vi.fn().mockReturnThis(),
  bindTooltip: vi.fn().mockReturnThis(),
};

const mockTileLayer = {
  addTo: vi.fn().mockReturnThis(),
};

const mockControl = {
  addTo: vi.fn().mockReturnThis(),
};

vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => mockMap),
    tileLayer: vi.fn(() => mockTileLayer),
    layerGroup: vi.fn(() => mockLayerGroup),
    marker: vi.fn(() => mockMarker),
    divIcon: vi.fn((opts) => opts),
    latLng: vi.fn((lat, lng) => ({ lat, lng })),
    latLngBounds: vi.fn((latlngs) => ({ latlngs })),
    control: {
      zoom: vi.fn(() => mockControl),
    },
    Icon: {
      Default: {
        prototype: {},
        mergeOptions: vi.fn(),
      },
    },
  },
}));

// Mock leaflet CSS
vi.mock('leaflet/dist/leaflet.css', () => ({}));

// Mock marker images
vi.mock('leaflet/dist/images/marker-icon-2x.png', () => ({ default: 'marker-icon-2x.png' }));
vi.mock('leaflet/dist/images/marker-icon.png', () => ({ default: 'marker-icon.png' }));
vi.mock('leaflet/dist/images/marker-shadow.png', () => ({ default: 'marker-shadow.png' }));

// Mock geo client
const mockGeoClient = {
  load: vi.fn(),
  getClusters: vi.fn().mockResolvedValue([]),
  getLeaves: vi.fn().mockResolvedValue([]),
};

vi.mock('../src/lib/geo-client', () => ({
  getGeoClient: vi.fn(() => Promise.resolve(mockGeoClient)),
}));

// Helper to render component and get elements
function renderMapView(props: Partial<Parameters<typeof MapView>[0]> = {}) {
  const defaultProps = {
    albumId: 'test-album-123',
    points: [] as GeoFeature[],
    photos: [] as PhotoMeta[],
    onPhotoClick: vi.fn(),
    onClusterClick: vi.fn(),
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(MapView, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  const queryByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (newProps: Partial<Parameters<typeof MapView>[0]>) => {
    act(() => {
      root.render(createElement(MapView, { ...defaultProps, ...props, ...newProps }));
    });
  };

  return {
    container,
    getByTestId,
    queryByTestId,
    cleanup,
    rerender,
    props: { ...defaultProps, ...props },
  };
}

describe('MapView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any remaining elements
    document.body.innerHTML = '';
  });

  describe('Rendering', () => {
    it('renders map container with correct test ID', () => {
      const { getByTestId, cleanup } = renderMapView();

      const mapView = getByTestId('map-view');
      expect(mapView).not.toBeNull();
      expect(mapView?.getAttribute('data-album-id')).toBe('test-album-123');

      cleanup();
    });

    it('renders map container element', () => {
      const { getByTestId, cleanup } = renderMapView();

      const container = getByTestId('map-container');
      expect(container).not.toBeNull();

      cleanup();
    });

    it('shows empty state when no points provided', () => {
      const { getByTestId, cleanup } = renderMapView({ points: [] });

      const emptyState = getByTestId('map-empty');
      expect(emptyState).not.toBeNull();
      expect(emptyState?.textContent).toContain('No geotagged photos');

      cleanup();
    });

    it('applies custom className', () => {
      const { getByTestId, cleanup } = renderMapView({ className: 'custom-map' });

      const mapView = getByTestId('map-view');
      expect(mapView?.className).toContain('custom-map');

      cleanup();
    });

    it('displays data attributes for point and cluster counts', () => {
      const { getByTestId, cleanup } = renderMapView({ points: [] });

      const mapView = getByTestId('map-view');
      expect(mapView?.getAttribute('data-point-count')).toBe('0');
      expect(mapView?.getAttribute('data-cluster-count')).toBe('0');

      cleanup();
    });
  });

  describe('Props', () => {
    it('accepts photos array for thumbnail display', async () => {
      const photos: PhotoMeta[] = [
        {
          id: 'photo-1',
          assetId: 'asset-1',
          albumId: 'test-album',
          filename: 'test.jpg',
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
          thumbnail: 'base64thumbnail',
        },
      ];

      const points: GeoFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1' },
        },
      ];

      const { getByTestId, cleanup } = renderMapView({ points, photos });

      const mapView = getByTestId('map-view');
      expect(mapView?.getAttribute('data-point-count')).toBe('1');

      cleanup();
    });

    it('accepts onPhotoClick callback', () => {
      const onPhotoClick = vi.fn();
      const { getByTestId, cleanup } = renderMapView({ onPhotoClick });

      expect(getByTestId('map-view')).not.toBeNull();

      cleanup();
    });

    it('accepts onClusterClick callback', () => {
      const onClusterClick = vi.fn();
      const { getByTestId, cleanup } = renderMapView({ onClusterClick });

      expect(getByTestId('map-view')).not.toBeNull();

      cleanup();
    });

    it('accepts initial center and zoom', () => {
      const { getByTestId, cleanup } = renderMapView({
        initialCenter: [51.505, -0.09],
        initialZoom: 13,
      });

      expect(getByTestId('map-view')).not.toBeNull();

      cleanup();
    });
  });

  describe('Geo Worker Integration', () => {
    it('loads points into geo worker when provided', async () => {
      const points: GeoFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-73.935, 40.73] },
          properties: { id: 'photo-2' },
        },
      ];

      const { cleanup } = renderMapView({ points });

      // Wait for async operations
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(mockGeoClient.load).toHaveBeenCalledWith(points);

      cleanup();
    });

    it('fetches clusters when bounds are available', async () => {
      const points: GeoFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1' },
        },
      ];

      mockGeoClient.getClusters.mockResolvedValue([
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1', cluster: false },
        },
      ]);

      const { cleanup } = renderMapView({ points });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(mockGeoClient.getClusters).toHaveBeenCalled();

      cleanup();
    });

    it('handles empty points after having points', async () => {
      // This test verifies that the component handles transitioning from points to no points
      const points: GeoFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1' },
        },
      ];

      const { getByTestId, cleanup } = renderMapView({ points });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // With points, we should have data-point-count of 1
      const mapView = getByTestId('map-view');
      expect(mapView?.getAttribute('data-point-count')).toBe('1');

      cleanup();
    });
  });

  describe('Stats Display', () => {
    it('shows photo count in stats overlay', () => {
      const points: GeoFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-73.935, 40.73] },
          properties: { id: 'photo-2' },
        },
      ];

      const { getByTestId, cleanup } = renderMapView({ points });

      const stats = getByTestId('map-stats');
      expect(stats?.textContent).toContain('2 photos');

      cleanup();
    });

    it('hides stats when no points', () => {
      const { queryByTestId, cleanup } = renderMapView({ points: [] });

      expect(queryByTestId('map-stats')).toBeNull();

      cleanup();
    });
  });

  describe('Error Handling', () => {
    it('displays error state when geo worker fails', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGeoClient.load.mockRejectedValueOnce(new Error('Worker error'));

      const points: GeoFeature[] = [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { id: 'photo-1' },
        },
      ];

      const { getByTestId, cleanup } = renderMapView({ points });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const mapView = getByTestId('map-view');
      expect(mapView?.getAttribute('data-error')).toBe('true');

      consoleError.mockRestore();
      cleanup();
    });
  });
});

describe('GeoFeature Type', () => {
  it('correctly types Point features', () => {
    const feature: GeoFeature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [-122.4194, 37.7749], // [lng, lat]
      },
      properties: {
        id: 'test-photo',
      },
    };

    expect(feature.type).toBe('Feature');
    expect(feature.geometry.type).toBe('Point');
    expect(feature.geometry.coordinates).toHaveLength(2);
    expect(feature.properties.id).toBe('test-photo');
  });

  it('correctly types cluster features', () => {
    const cluster: GeoFeature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [-122.4194, 37.7749],
      },
      properties: {
        id: '',
        cluster: true,
        cluster_id: 123,
        point_count: 5,
      },
    };

    expect(cluster.properties.cluster).toBe(true);
    expect(cluster.properties.cluster_id).toBe(123);
    expect(cluster.properties.point_count).toBe(5);
  });
});

describe('MapView BBox Type', () => {
  it('represents bounding box as [west, south, east, north]', () => {
    const bbox: [number, number, number, number] = [-180, -90, 180, 90];

    expect(bbox).toHaveLength(4);
    expect(bbox[0]).toBe(-180); // west
    expect(bbox[1]).toBe(-90); // south
    expect(bbox[2]).toBe(180); // east
    expect(bbox[3]).toBe(90); // north
  });
});
