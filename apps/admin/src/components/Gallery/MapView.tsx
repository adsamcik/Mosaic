import { useState, useEffect, useCallback } from 'react';
import { getGeoClient } from '../../lib/geo-client';
import type { GeoFeature } from '../../workers/types';

/** Map bounding box as [west, south, east, north] */
export type BBox = [number, number, number, number];

/** Props for MapView component */
export interface MapViewProps {
  /** Album ID to display photos for */
  albumId: string;
  /** Map bounding box [westLng, southLat, eastLng, northLat] */
  bounds: BBox;
  /** Map zoom level (0-20) */
  zoom: number;
  /** Photo points to display (will be loaded into geo worker) */
  points?: GeoFeature[];
  /** Callback when a marker/cluster is clicked */
  onMarkerClick?: (feature: GeoFeature) => void;
  /** Callback when map bounds change */
  onBoundsChange?: (bounds: BBox, zoom: number) => void;
  /** Optional CSS class name */
  className?: string;
}

/**
 * MapView Component
 * Displays photo locations on a map with clustering support
 *
 * Note: This is a placeholder implementation with data attributes.
 * Real map library integration (e.g., Mapbox, Leaflet) will come later.
 */
export function MapView({
  albumId,
  bounds,
  zoom,
  points = [],
  onMarkerClick,
  onBoundsChange,
  className,
}: MapViewProps) {
  const [clusters, setClusters] = useState<GeoFeature[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Load points into geo worker when points change
  useEffect(() => {
    if (points.length === 0) {
      setClusters([]);
      return;
    }

    const loadPoints = async () => {
      try {
        const geo = await getGeoClient();
        await geo.load(points);
      } catch (err) {
        console.error('Failed to load points into geo worker:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    loadPoints();
  }, [points]);

  // Get clusters when bounds or zoom change
  useEffect(() => {
    if (points.length === 0) {
      return;
    }

    const fetchClusters = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const geo = await getGeoClient();
        const result = await geo.getClusters(bounds, zoom);
        setClusters(result);
      } catch (err) {
        console.error('Failed to get clusters:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    };

    fetchClusters();
  }, [bounds, zoom, points.length]);

  /**
   * Handle click on a marker or cluster
   */
  const handleMarkerClick = useCallback(
    (feature: GeoFeature) => {
      onMarkerClick?.(feature);
    },
    [onMarkerClick]
  );

  /**
   * Simulate bounds change (for future map integration)
   */
  const handleBoundsChange = useCallback(
    (newBounds: BBox, newZoom: number) => {
      onBoundsChange?.(newBounds, newZoom);
    },
    [onBoundsChange]
  );

  // Render loading state
  if (isLoading && clusters.length === 0) {
    return (
      <div
        className={className}
        data-testid="map-view"
        data-album-id={albumId}
        data-loading="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '400px',
          backgroundColor: 'var(--color-surface, #1a1a2e)',
          borderRadius: '8px',
        }}
      >
        <span style={{ color: 'var(--color-text-muted, #888)' }}>
          Loading map...
        </span>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div
        className={className}
        data-testid="map-view"
        data-album-id={albumId}
        data-error="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '400px',
          backgroundColor: 'var(--color-surface, #1a1a2e)',
          borderRadius: '8px',
        }}
      >
        <span style={{ color: 'var(--color-error, #ff6b6b)' }}>
          Failed to load map: {error.message}
        </span>
      </div>
    );
  }

  return (
    <div
      className={className}
      data-testid="map-view"
      data-album-id={albumId}
      data-bounds={JSON.stringify(bounds)}
      data-zoom={zoom}
      data-cluster-count={clusters.length}
      data-point-count={points.length}
      style={{
        position: 'relative',
        minHeight: '400px',
        backgroundColor: 'var(--color-surface, #1a1a2e)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
      onClick={() => handleBoundsChange(bounds, zoom)}
    >
      {/* Placeholder map area */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-muted, #888)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🗺️</div>
          <div>Map View Placeholder</div>
          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            {points.length} photos • {clusters.length} clusters
          </div>
        </div>
      </div>

      {/* Render markers/clusters as positioned divs */}
      {clusters.map((feature) => {
        const [lng, lat] = feature.geometry.coordinates;
        const isCluster = feature.properties.cluster === true;

        // Calculate position (simplified - real implementation would use map projection)
        const x =
          ((lng - bounds[0]) / (bounds[2] - bounds[0])) * 100;
        const y =
          ((bounds[3] - lat) / (bounds[3] - bounds[1])) * 100;

        return (
          <div
            key={
              isCluster
                ? `cluster-${feature.properties.cluster_id}`
                : feature.properties.id
            }
            data-feature-id={feature.properties.id}
            data-cluster={isCluster}
            data-cluster-id={feature.properties.cluster_id}
            data-point-count={feature.properties.point_count}
            onClick={(e) => {
              e.stopPropagation();
              handleMarkerClick(feature);
            }}
            style={{
              position: 'absolute',
              left: `${Math.max(0, Math.min(100, x))}%`,
              top: `${Math.max(0, Math.min(100, y))}%`,
              transform: 'translate(-50%, -50%)',
              width: isCluster ? '40px' : '24px',
              height: isCluster ? '40px' : '24px',
              borderRadius: '50%',
              backgroundColor: isCluster
                ? 'var(--color-primary, #4a9eff)'
                : 'var(--color-accent, #ff6b6b)',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: isCluster ? '12px' : '10px',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
              transition: 'transform 0.2s ease',
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.transform =
                'translate(-50%, -50%) scale(1.1)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.transform =
                'translate(-50%, -50%)';
            }}
          >
            {isCluster ? feature.properties.point_count : '📷'}
          </div>
        );
      })}
    </div>
  );
}
