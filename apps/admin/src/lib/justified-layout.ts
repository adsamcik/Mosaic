/**
 * Justified Photo Grid Layout
 *
 * Google Photos-style layout that arranges photos in rows where each row
 * fills the available width while maintaining photo aspect ratios.
 *
 * Algorithm:
 * 1. Set a target row height
 * 2. Add photos to a row until the row width exceeds container width
 * 3. Scale the row to fit exactly, adjusting photo heights
 * 4. Photos in the last row may not fill the width (partial row)
 */

import type { PhotoMeta } from '../workers/types';

/** Photo with computed display dimensions */
export interface JustifiedPhoto {
  photo: PhotoMeta;
  width: number;
  height: number;
}

/** Row of justified photos */
export interface JustifiedRow {
  photos: JustifiedPhoto[];
  height: number;
}

/** Configuration for justified layout */
export interface JustifiedLayoutConfig {
  /** Container width in pixels */
  containerWidth: number;
  /** Target row height in pixels (default: 220) */
  targetRowHeight?: number;
  /** Gap between photos in pixels (default: 4) */
  gap?: number;
  /** Minimum photo width in pixels (default: 100) */
  minPhotoWidth?: number;
  /** Maximum row height multiplier (default: 1.5) */
  maxRowHeightMultiplier?: number;
}

/** Default aspect ratio for photos without dimensions */
const DEFAULT_ASPECT_RATIO = 4 / 3;

/** Default target row height */
const DEFAULT_ROW_HEIGHT = 220;

/** Default gap between photos */
const DEFAULT_GAP = 4;

/** Default minimum photo width */
const DEFAULT_MIN_WIDTH = 100;

/** Default maximum row height multiplier */
const DEFAULT_MAX_HEIGHT_MULTIPLIER = 1.5;

/**
 * Get photo aspect ratio from metadata
 * Falls back to default if dimensions not available
 */
function getAspectRatio(photo: PhotoMeta): number {
  if (photo.width && photo.height && photo.height > 0) {
    return photo.width / photo.height;
  }
  return DEFAULT_ASPECT_RATIO;
}

/**
 * Compute justified layout for a set of photos
 *
 * @param photos - Photos to layout
 * @param config - Layout configuration
 * @returns Array of justified rows
 */
export function computeJustifiedLayout(
  photos: PhotoMeta[],
  config: JustifiedLayoutConfig,
): JustifiedRow[] {
  const {
    containerWidth,
    targetRowHeight = DEFAULT_ROW_HEIGHT,
    gap = DEFAULT_GAP,
    minPhotoWidth = DEFAULT_MIN_WIDTH,
    maxRowHeightMultiplier = DEFAULT_MAX_HEIGHT_MULTIPLIER,
  } = config;

  if (photos.length === 0 || containerWidth <= 0) {
    return [];
  }

  const rows: JustifiedRow[] = [];
  let currentRow: { photo: PhotoMeta; aspectRatio: number }[] = [];
  let currentRowAspectSum = 0;

  // Calculate how many photos can fit in a row at target height
  const getRowWidth = (
    aspectSum: number,
    rowHeight: number,
    photoCount: number,
  ): number => {
    return aspectSum * rowHeight + (photoCount - 1) * gap;
  };

  for (const photo of photos) {
    const aspectRatio = getAspectRatio(photo);

    // Add photo to current row
    currentRow.push({ photo, aspectRatio });
    currentRowAspectSum += aspectRatio;

    // Check if row is full
    const rowWidth = getRowWidth(
      currentRowAspectSum,
      targetRowHeight,
      currentRow.length,
    );

    if (rowWidth >= containerWidth) {
      // Calculate the actual row height to fit exactly in container
      // containerWidth = aspectSum * height + (n-1) * gap
      // height = (containerWidth - (n-1) * gap) / aspectSum
      const actualHeight =
        (containerWidth - (currentRow.length - 1) * gap) / currentRowAspectSum;

      // Clamp height to reasonable bounds and floor to avoid sub-pixel rendering issues
      const clampedHeight = Math.floor(
        Math.min(actualHeight, targetRowHeight * maxRowHeightMultiplier),
      );

      // Create justified row - all photos in the same row have the same height
      const justifiedPhotos: JustifiedPhoto[] = currentRow.map(
        ({ photo: p, aspectRatio: ar }) => ({
          photo: p,
          width: Math.floor(ar * clampedHeight),
          height: clampedHeight,
        }),
      );

      // Adjust last photo width to fill remaining space exactly
      if (justifiedPhotos.length > 0) {
        const totalWidth = justifiedPhotos.reduce(
          (sum, jp) => sum + jp.width,
          0,
        );
        const totalGaps = (justifiedPhotos.length - 1) * gap;
        const remaining = containerWidth - totalWidth - totalGaps;
        const lastPhoto = justifiedPhotos[justifiedPhotos.length - 1];
        if (lastPhoto) {
          lastPhoto.width += remaining;
        }
      }

      rows.push({
        photos: justifiedPhotos,
        height: clampedHeight,
      });

      // Reset for next row
      currentRow = [];
      currentRowAspectSum = 0;
    }
  }

  // Handle partial last row (don't stretch to fill width)
  if (currentRow.length > 0) {
    // Use target row height for partial row (already an integer)
    const rowHeight = Math.floor(targetRowHeight);

    const justifiedPhotos: JustifiedPhoto[] = currentRow.map(
      ({ photo: p, aspectRatio: ar }) => {
        const width = Math.max(Math.floor(ar * rowHeight), minPhotoWidth);
        return {
          photo: p,
          width,
          height: rowHeight,
        };
      },
    );

    rows.push({
      photos: justifiedPhotos,
      height: rowHeight,
    });
  }

  return rows;
}

/**
 * Calculate total height of all rows
 */
export function getTotalHeight(
  rows: JustifiedRow[],
  gap: number = DEFAULT_GAP,
): number {
  if (rows.length === 0) return 0;
  return (
    rows.reduce((sum, row) => sum + row.height, 0) + (rows.length - 1) * gap
  );
}

/**
 * Find which row a photo is in by photo ID
 */
export function findPhotoRow(
  rows: JustifiedRow[],
  photoId: string,
): { rowIndex: number; photoIndex: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row) continue;

    for (let photoIndex = 0; photoIndex < row.photos.length; photoIndex++) {
      const jp = row.photos[photoIndex];
      if (jp && jp.photo.id === photoId) {
        return { rowIndex, photoIndex };
      }
    }
  }
  return null;
}

/**
 * Get the row offset (Y position) for a given row index
 * Returns an integer to avoid sub-pixel rendering issues
 */
export function getRowOffset(
  rows: JustifiedRow[],
  rowIndex: number,
  gap: number = DEFAULT_GAP,
): number {
  let offset = 0;
  for (let i = 0; i < rowIndex && i < rows.length; i++) {
    const row = rows[i];
    if (row) {
      offset += row.height + gap;
    }
  }
  return Math.floor(offset);
}

/**
 * Find visible rows for virtualization
 */
export function getVisibleRows(
  rows: JustifiedRow[],
  scrollTop: number,
  viewportHeight: number,
  gap: number = DEFAULT_GAP,
  overscan: number = 2,
): { startIndex: number; endIndex: number; offsetY: number } {
  if (rows.length === 0) {
    return { startIndex: 0, endIndex: 0, offsetY: 0 };
  }

  let startIndex = 0;
  let currentY = 0;

  // Find first visible row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const rowBottom = currentY + row.height;
    if (rowBottom >= scrollTop) {
      startIndex = Math.max(0, i - overscan);
      break;
    }
    currentY = rowBottom + gap;
  }

  // Find last visible row
  let endIndex = startIndex;
  const visibleBottom = scrollTop + viewportHeight;
  currentY = getRowOffset(rows, startIndex, gap);

  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    endIndex = i;
    if (currentY > visibleBottom) {
      endIndex = Math.min(rows.length - 1, i + overscan);
      break;
    }
    currentY += row.height + gap;
  }

  // Ensure we include overscan at the end
  endIndex = Math.min(rows.length - 1, endIndex + overscan);

  const offsetY = getRowOffset(rows, startIndex, gap);

  return { startIndex, endIndex, offsetY };
}
