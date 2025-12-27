/**
 * Map View Component
 *
 * Displays photo locations on an interactive Leaflet map with clustering support.
 * Integrates with the geo worker for efficient Supercluster-based clustering.
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getGeoClient } from '../../lib/geo-client';
import type { GeoFeature, PhotoMeta } from '../../workers/types';

// Fix for default marker icons in Vite/Webpack bundlers
// Leaflet's default icons use a path that doesn't work with module bundlers
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Apply the icon fix
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

/** Map bounding box as [west, south, east, north] */
export type BBox = [number, number, number, number];

/** Props for MapView component */
export interface MapViewProps {
  /** Album ID to display photos for */
  albumId: string;
  /** Photo points to display (will be loaded into geo worker) */
  points?: GeoFeature[];
  /** Photos with metadata for thumbnail display */
  photos?: PhotoMeta[];
  /** Callback when a single photo is clicked */
  onPhotoClick?: (photoId: string) => void;
  /** Callback when a cluster is clicked with the photo IDs */
  onClusterClick?: (photoIds: string[]) => void;
  /** Optional CSS class name */
  className?: string;
  /** Initial center coordinates [lat, lng] */
  initialCenter?: [number, number];
  /** Initial zoom level */
  initialZoom?: number;
}

/** Default map center (roughly center of world) */
const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 2;
const MIN_ZOOM = 1;
const MAX_ZOOM = 18;

/** Cluster size thresholds for styling */
const CLUSTER_SIZE_SMALL = 10;
const CLUSTER_SIZE_MEDIUM = 100;

/**
 * Get cluster marker size based on point count
 */
function getClusterSize(count: number): number {
  if (count < CLUSTER_SIZE_SMALL) return 30;
  if (count < CLUSTER_SIZE_MEDIUM) return 40;
  return 50;
}

/**
 * Get cluster marker color based on point count
 */
function getClusterColor(count: number): string {
  if (count < CLUSTER_SIZE_SMALL) return 'var(--color-primary, #3b82f6)';
  if (count < CLUSTER_SIZE_MEDIUM) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-error, #ef4444)';
}

/**
 * Create a cluster marker icon
 */
function createClusterIcon(count: number): L.DivIcon {
  const size = getClusterSize(count);
  const color = getClusterColor(count);

  return L.divIcon({
    html: `
      <div class="map-cluster-marker" style="
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-size: ${size > 40 ? 14 : 12}px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        border: 2px solid white;
        cursor: pointer;
        transition: transform 0.2s ease;
      ">
        ${count}
      </div>
    `,
    className: 'map-cluster-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * Create a photo marker icon with optional thumbnail
 */
function createPhotoIcon(photo?: PhotoMeta): L.DivIcon {
  const size = 40;
  const thumbnailHtml = photo?.thumbnail
    ? `<img src="data:image/jpeg;base64,${photo.thumbnail}" alt="" style="
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
      " />`
    : `<span style="font-size: 18px;">📷</span>`;

  return L.divIcon({
    html: `
      <div class="map-photo-marker" style="
        width: ${size}px;
        height: ${size}px;
        background: var(--color-surface, #1a1a1a);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        border: 2px solid var(--color-primary, #3b82f6);
        cursor: pointer;
        overflow: hidden;
        transition: transform 0.2s ease;
      ">
        ${thumbnailHtml}
      </div>
    `,
    className: 'map-photo-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * MapView Component
 * Displays photo locations on an interactive Leaflet map with clustering
 */
export function MapView({
  albumId,
  points = [],
  photos = [],
  onPhotoClick,
  onClusterClick,
  className,
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
}: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [clusters, setClusters] = useState<GeoFeature[]>([]);
  const [currentBounds, setCurrentBounds] = useState<BBox | null>(null);
  const [currentZoom, setCurrentZoom] = useState(initialZoom);

  // Create a map from photo ID to PhotoMeta for quick lookup
  const photoMap = useRef<Map<string, PhotoMeta>>(new Map());
  useEffect(() => {
    photoMap.current = new Map(photos.map((p) => [p.id, p]));
  }, [photos]);

  // Initialize the Leaflet map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      zoomControl: false, // We'll add custom controls
    });

    // Add OpenStreetMap tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: MAX_ZOOM,
    }).addTo(map);

    // Add zoom control in bottom right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Create layer group for markers
    const markersLayer = L.layerGroup().addTo(map);
    markersLayerRef.current = markersLayer;

    // Store map reference
    mapRef.current = map;

    // Set up event handlers
    const updateBounds = () => {
      const bounds = map.getBounds();
      const bbox: BBox = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ];
      setCurrentBounds(bbox);
      setCurrentZoom(map.getZoom());
    };

    map.on('moveend', updateBounds);
    map.on('zoomend', updateBounds);

    // Initial bounds
    updateBounds();

    // Cleanup
    return () => {
      map.off('moveend', updateBounds);
      map.off('zoomend', updateBounds);
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
    };
  }, [initialCenter, initialZoom]);

  // Load points into geo worker when they change
  useEffect(() => {
    if (points.length === 0) {
      setClusters([]);
      return;
    }

    const loadPoints = async () => {
      try {
        const geo = await getGeoClient();
        await geo.load(points);

        // Trigger cluster update if we have bounds
        if (currentBounds) {
          const result = await geo.getClusters(currentBounds, Math.floor(currentZoom));
          setClusters(result);
        }
      } catch (err) {
        console.error('Failed to load points into geo worker:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    loadPoints();
  }, [points, currentBounds, currentZoom]);

  // Fetch clusters when bounds or zoom change
  useEffect(() => {
    if (points.length === 0 || !currentBounds) {
      return;
    }

    const fetchClusters = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const geo = await getGeoClient();
        const result = await geo.getClusters(currentBounds, Math.floor(currentZoom));
        setClusters(result);
      } catch (err) {
        console.error('Failed to get clusters:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    };

    fetchClusters();
  }, [currentBounds, currentZoom, points.length]);

  // Handle cluster click - zoom in or get leaves
  const handleClusterClick = useCallback(
    async (feature: GeoFeature) => {
      if (!mapRef.current) return;

      const clusterId = feature.properties.cluster_id;
      if (clusterId === undefined) return;

      try {
        const geo = await getGeoClient();
        const leaves = await geo.getLeaves(clusterId, 100, 0);
        const photoIds = leaves.map((l) => l.properties.id);

        // If we have a small number of photos or at max zoom, trigger callback
        if (photoIds.length <= 10 || currentZoom >= MAX_ZOOM - 1) {
          onClusterClick?.(photoIds);
        } else {
          // Zoom in to cluster
          const [lng, lat] = feature.geometry.coordinates;
          mapRef.current.setView([lat, lng], Math.min(currentZoom + 3, MAX_ZOOM));
        }
      } catch (err) {
        console.error('Failed to handle cluster click:', err);
      }
    },
    [currentZoom, onClusterClick]
  );

  // Handle photo click
  const handlePhotoClick = useCallback(
    (photoId: string) => {
      onPhotoClick?.(photoId);
    },
    [onPhotoClick]
  );

  // Update markers when clusters change
  useEffect(() => {
    const markersLayer = markersLayerRef.current;
    if (!markersLayer) return;

    // Clear existing markers
    markersLayer.clearLayers();

    // Add new markers
    clusters.forEach((feature) => {
      const [lng, lat] = feature.geometry.coordinates;
      const isCluster = feature.properties.cluster === true;

      if (isCluster) {
        // Create cluster marker
        const count = feature.properties.point_count || 0;
        const icon = createClusterIcon(count);

        const marker = L.marker([lat, lng], { icon });
        marker.on('click', () => handleClusterClick(feature));

        // Add tooltip
        marker.bindTooltip(`${count} photos`, {
          direction: 'top',
          offset: [0, -getClusterSize(count) / 2],
        });

        markersLayer.addLayer(marker);
      } else {
        // Create photo marker
        const photoId = feature.properties.id;
        const photo = photoMap.current.get(photoId);
        const icon = createPhotoIcon(photo);

        const marker = L.marker([lat, lng], { icon });
        marker.on('click', () => handlePhotoClick(photoId));

        // Add tooltip with photo info
        const tooltipContent = photo
          ? `${photo.filename}${photo.takenAt ? `<br>${new Date(photo.takenAt).toLocaleDateString()}` : ''}`
          : photoId;

        marker.bindTooltip(tooltipContent, {
          direction: 'top',
          offset: [0, -20],
        });

        markersLayer.addLayer(marker);
      }
    });
  }, [clusters, handleClusterClick, handlePhotoClick]);

  // Fit map to points when they're loaded
  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;

    // Calculate bounds from points
    const latLngs = points.map((p) => {
      const [lng, lat] = p.geometry.coordinates;
      return L.latLng(lat, lng);
    });

    if (latLngs.length > 0) {
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }
  }, [points]);

  // Render error state
  if (error) {
    return (
      <div
        className={`map-view map-view--error ${className || ''}`}
        data-testid="map-view"
        data-album-id={albumId}
        data-error="true"
      >
        <div className="map-view-message">
          <span className="map-view-error-icon">⚠️</span>
          <span>Failed to load map: {error.message}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`map-view ${className || ''}`}
      data-testid="map-view"
      data-album-id={albumId}
      data-cluster-count={clusters.length}
      data-point-count={points.length}
    >
      {/* Map container */}
      <div ref={mapContainerRef} className="map-view-container" data-testid="map-container" />

      {/* Loading overlay */}
      {isLoading && (
        <div className="map-view-loading" data-testid="map-loading">
          <div className="loading-spinner" />
        </div>
      )}

      {/* Empty state overlay */}
      {points.length === 0 && !isLoading && (
        <div className="map-view-empty" data-testid="map-empty">
          <span className="map-view-empty-icon">🗺️</span>
          <span>No geotagged photos in this album</span>
        </div>
      )}

      {/* Stats overlay */}
      {points.length > 0 && (
        <div className="map-view-stats" data-testid="map-stats">
          <span>{points.length} photos</span>
          {clusters.length > 0 && clusters.length !== points.length && (
            <span> • {clusters.length} clusters</span>
          )}
        </div>
      )}
    </div>
  );
}
