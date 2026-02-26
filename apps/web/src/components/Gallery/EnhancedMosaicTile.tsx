/**
 * Enhanced Mosaic Tile Component (v2)
 *
 * Renders individual tiles in the enhanced mosaic layout, supporting:
 * - Standard photo tiles
 * - Hero (large) photo tiles
 * - Story tiles (photo + description)
 * - Map cluster tiles (mini-map showing photo locations)
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { EnhancedMosaicItem } from '../../lib/mosaic-layout-v2';
import type { PhotoMeta } from '../../workers/types';

interface EnhancedMosaicTileProps {
  item: EnhancedMosaicItem;
  photo?: PhotoMeta;
  photos?: Map<string, PhotoMeta>;
  onClick?: () => void;
  onMapClick?: (
    coordinates: Array<{ lat: number; lng: number; photoId: string }>,
  ) => void;
  renderThumbnail: (props: {
    photo: PhotoMeta;
    width: number;
    height: number;
    onClick?: () => void;
  }) => React.ReactNode;
  /**
   * When true, skip absolute positioning (used when wrapped by AnimatedTile).
   * The wrapper handles positioning, tile just fills its container.
   */
  skipPositioning?: boolean;
}

/**
 * Mini-map component for map cluster tiles
 * Uses a simple canvas-based approach for lightweight rendering
 */
const MiniMap = memo(function MiniMap({
  coordinates,
  width,
  height,
  onClick,
}: {
  coordinates: Array<{ lat: number; lng: number; photoId: string }>;
  width: number;
  height: number;
  onClick?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || coordinates.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas resolution
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Calculate bounds
    const lats = coordinates.map((c) => c.lat);
    const lngs = coordinates.map((c) => c.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    // Add padding
    const latPadding = (maxLat - minLat) * 0.2 || 0.01;
    const lngPadding = (maxLng - minLng) * 0.2 || 0.01;
    const bounds = {
      minLat: minLat - latPadding,
      maxLat: maxLat + latPadding,
      minLng: minLng - lngPadding,
      maxLng: maxLng + lngPadding,
    };

    // Clear canvas
    ctx.fillStyle = 'var(--bg-secondary, #f5f5f5)';
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines for visual reference
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)';
    ctx.lineWidth = 1;

    for (let i = 1; i < 4; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      const x = (width / 4) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Convert coordinates to canvas positions
    const toCanvasX = (lng: number) =>
      ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * width;
    const toCanvasY = (lat: number) =>
      height -
      ((lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * height;

    // Draw connecting lines
    if (coordinates.length > 1) {
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(
        toCanvasX(coordinates[0]!.lng),
        toCanvasY(coordinates[0]!.lat),
      );
      for (let i = 1; i < coordinates.length; i++) {
        ctx.lineTo(
          toCanvasX(coordinates[i]!.lng),
          toCanvasY(coordinates[i]!.lat),
        );
      }
      ctx.stroke();
    }

    // Draw points
    coordinates.forEach((coord, index) => {
      const x = toCanvasX(coord.lng);
      const y = toCanvasY(coord.lat);

      // Outer glow
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.3)';
      ctx.fill();

      // Inner point
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#3b82f6';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Number label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), x, y);
    });
  }, [coordinates, width, height]);

  return (
    <div
      className="mini-map-container"
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: onClick ? 'pointer' : 'default',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />

      {/* Location count badge */}
      <div
        style={{
          position: 'absolute',
          top: '8px',
          left: '8px',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          padding: '4px 8px',
          borderRadius: '12px',
          fontSize: '12px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
        </svg>
        {coordinates.length} locations
      </div>

      {/* Hover overlay */}
      {isHovered && onClick && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          Click to view on map
        </div>
      )}
    </div>
  );
});

export const EnhancedMosaicTile = memo(function EnhancedMosaicTile({
  item,
  photo,
  onClick,
  onMapClick,
  renderThumbnail,
  skipPositioning = false,
}: EnhancedMosaicTileProps) {
  // Compute base positioning style (can be skipped when wrapped by AnimatedTile)
  const positionStyle = skipPositioning
    ? { width: '100%', height: '100%' }
    : {
        position: 'absolute' as const,
        top: item.rect.top,
        left: item.rect.left,
        width: item.rect.width,
        height: item.rect.height,
      };

  const handleMapClick = useCallback(() => {
    if (item.coordinates && onMapClick) {
      onMapClick(item.coordinates);
    }
  }, [item.coordinates, onMapClick]);

  // Map Cluster Tile
  if (item.type === 'map-cluster') {
    return (
      <div
        className="mosaic-tile mosaic-map-tile"
        style={{
          position: 'absolute',
          top: item.rect.top,
          left: item.rect.left,
          width: item.rect.width,
          height: item.rect.height,
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: '8px',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        }}
      >
        <MiniMap
          coordinates={item.coordinates || []}
          width={item.rect.width}
          height={item.rect.height}
          onClick={handleMapClick}
        />
      </div>
    );
  }

  // Story Tile (Photo + Description)
  if (item.type === 'story' && photo) {
    return (
      <div
        className="mosaic-tile mosaic-story-tile"
        style={{
          position: 'absolute',
          top: item.rect.top,
          left: item.rect.left,
          width: item.rect.width,
          height: item.rect.height,
          display: 'flex',
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: '8px',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        }}
      >
        {/* Photo Section - 50% width */}
        <div style={{ width: '50%', height: '100%', position: 'relative' }}>
          {renderThumbnail({
            photo,
            width: item.rect.width / 2,
            height: item.rect.height,
            ...(onClick ? { onClick } : {}),
          })}
        </div>

        {/* Text Section */}
        <div
          style={{
            width: '50%',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '12px',
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: '1.1rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {new Date(photo.createdAt).toLocaleDateString(undefined, {
                dateStyle: 'long',
              })}
            </h3>

            {/* Location badge if available */}
            {photo.lat != null && photo.lng != null && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  color: '#3b82f6',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '12px',
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
                </svg>
              </span>
            )}
          </div>

          <p
            style={{
              margin: 0,
              lineHeight: 1.6,
              color: 'var(--text-secondary)',
              fontSize: '1rem',
              whiteSpace: 'pre-wrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 6,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {item.description}
          </p>
        </div>
      </div>
    );
  }

  // Description Panel (standalone)
  if (item.type === 'description-panel') {
    return (
      <div
        className="mosaic-tile mosaic-description-tile"
        style={{
          position: 'absolute',
          top: item.rect.top,
          left: item.rect.left,
          width: item.rect.width,
          height: item.rect.height,
          padding: '20px',
          backgroundColor: 'var(--bg-tertiary)',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            margin: 0,
            lineHeight: 1.6,
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            fontStyle: 'italic',
          }}
        >
          "{item.description}"
        </p>
      </div>
    );
  }

  // Standard or Hero Photo Tile
  if (photo) {
    return (
      <div
        className={`mosaic-tile mosaic-${item.type}-tile`}
        style={positionStyle}
      >
        {renderThumbnail({
          photo,
          width: item.rect.width,
          height: item.rect.height,
          ...(onClick ? { onClick } : {}),
        })}
      </div>
    );
  }

  // Fallback for missing photo
  return (
    <div
      className="mosaic-tile mosaic-empty-tile"
      style={{
        ...positionStyle,
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '4px',
      }}
    />
  );
});
