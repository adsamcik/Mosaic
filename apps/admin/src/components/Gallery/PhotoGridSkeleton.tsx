/**
 * PhotoGridSkeleton Component
 * 
 * Loading skeleton for the photo grid with shimmer animation.
 * Provides visual feedback during initial load and respects reduced motion preferences.
 * 
 * @module PhotoGridSkeleton
 */

import { memo, useMemo } from 'react';
import '../../styles/animations.css';

/** Props for PhotoGridSkeleton component */
export interface PhotoGridSkeletonProps {
  /** Number of skeleton tiles to render. Default: 12 */
  count?: number;
  /** Number of columns in the grid. Default: 4 */
  columns?: number;
  /** Aspect ratio for each tile. Default: 1 (square) */
  aspectRatio?: number;
  /** Enable staggered reveal animation. Default: true */
  staggerReveal?: boolean;
  /** Test ID for testing */
  'data-testid'?: string;
}

/**
 * PhotoGridSkeleton - Loading placeholder for photo grid
 * 
 * Features:
 * - Shimmer animation
 * - Responsive column adjustment
 * - Staggered reveal option
 * - Reduced motion support
 * 
 * @example
 * ```tsx
 * if (isLoading) {
 *   return <PhotoGridSkeleton count={16} columns={4} />;
 * }
 * ```
 */
export const PhotoGridSkeleton = memo(function PhotoGridSkeleton({
  count = 12,
  columns = 4,
  aspectRatio = 1,
  staggerReveal = true,
  'data-testid': testId = 'photo-grid-skeleton',
}: PhotoGridSkeletonProps) {
  // Generate skeleton tiles with stagger delays
  const tiles = useMemo(() => {
    return Array.from({ length: count }, (_, index) => {
      // Calculate stagger delay based on position in grid
      const row = Math.floor(index / columns);
      const col = index % columns;
      // Diagonal wave pattern
      const staggerDelay = staggerReveal ? (col * 50) + (row * 100) : 0;
      
      return {
        key: `skeleton-${index}`,
        staggerDelay,
      };
    });
  }, [count, columns, staggerReveal]);

  return (
    <div
      className="photo-grid-skeleton"
      data-testid={testId}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: '4px',
        padding: '4px',
        width: '100%',
      }}
    >
      {tiles.map(({ key, staggerDelay }) => (
        <div
          key={key}
          className={`skeleton-tile ${staggerReveal ? 'reveal-stagger' : ''}`}
          style={{
            aspectRatio: String(aspectRatio),
            minHeight: '100px',
            '--reveal-delay': `${staggerDelay}ms`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
});

/**
 * Props for SkeletonTile component
 */
export interface SkeletonTileProps {
  /** Width of the tile */
  width?: number | string;
  /** Height of the tile */
  height?: number | string;
  /** Border radius. Default: 4 */
  borderRadius?: number | string;
  /** Whether the tile is "loaded" (triggers fade out). Default: false */
  isLoaded?: boolean;
  /** Additional className */
  className?: string;
}

/**
 * Individual skeleton tile with shimmer effect
 */
export const SkeletonTile = memo(function SkeletonTile({
  width = '100%',
  height = '100%',
  borderRadius = 4,
  isLoaded = false,
  className = '',
}: SkeletonTileProps) {
  const loadedClass = isLoaded ? 'skeleton-tile-loaded' : '';
  
  return (
    <div
      className={`skeleton-tile ${loadedClass} ${className}`.trim()}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius,
      }}
    />
  );
});
