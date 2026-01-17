/**
 * Enhanced Mosaic Layout Algorithm (v2)
 *
 * A "Justified" or "Row-Based" photo gallery layout that:
 * 1. Distributes images into rows where every row fills container width exactly
 * 2. Preserves aspect ratios without cropping
 * 3. Intelligently inserts map tiles when photos have GPS clusters
 * 4. Intelligently inserts description panels for photos with meaningful descriptions
 *
 * Algorithm Overview:
 * 1. Normalization: Calculate aspect ratio for each image, scale to target height
 * 2. Row Building: Add images until sum of tentative widths exceeds container
 * 3. Justify: Calculate exact height to make row fit perfectly
 * 4. Orphan Handling: Last row keeps target height, aligned left
 */

import type { PhotoMeta } from '../workers/types';

// ============================================================================
// Types
// ============================================================================

/** Configuration for the mosaic layout */
export interface MosaicLayoutConfig {
  /** Container width in pixels */
  containerWidth: number;
  /** Target row height in pixels (ideal height, will fluctuate) */
  targetRowHeight: number;
  /** Gap between photos in pixels */
  gap: number;
  /** Minimum photo width to prevent tiny thumbnails */
  minPhotoWidth?: number;
  /** Maximum row height multiplier (prevents excessively tall rows) */
  maxRowHeightMultiplier?: number;
  /** Minimum row height multiplier (prevents excessively short rows) */
  minRowHeightMultiplier?: number;
  /** Enable smart map tile insertion */
  enableMapTiles?: boolean;
  /** Enable smart description tiles */
  enableDescriptionTiles?: boolean;
  /** Minimum description length to trigger a description tile */
  minDescriptionLength?: number;
  /** Minimum photos with GPS in a row to trigger a map tile */
  minPhotosForMapTile?: number;
}

/** Types of tiles in the mosaic */
export type EnhancedTileType =
  | 'standard' // Regular photo tile
  | 'hero' // Larger prominent photo
  | 'story' // Photo + description side by side
  | 'map-cluster' // Map showing photo locations
  | 'description-panel'; // Standalone description panel

/** A calculated item in the layout */
export interface EnhancedMosaicItem {
  /** Unique ID for this tile */
  id: string;
  /** Photo ID (if this tile contains a photo) */
  photoId?: string;
  /** Tile type */
  type: EnhancedTileType;
  /** Position and dimensions */
  rect: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
  /** Description text (for story/description tiles) */
  description?: string;
  /** Is this a portrait photo? */
  isPortrait?: boolean;
  /** GPS coordinates for map tiles */
  coordinates?: Array<{ lat: number; lng: number; photoId: string }>;
  /** Photo IDs associated with this tile (for map clusters) */
  associatedPhotoIds?: string[];
}

/** A row in the layout */
export interface LayoutRow {
  /** Row height */
  height: number;
  /** Items in this row */
  items: EnhancedMosaicItem[];
  /** Top position of this row */
  top: number;
  /** Is this the last (orphan) row? */
  isOrphan?: boolean;
}

/** Normalized photo with pre-calculated values */
interface NormalizedPhoto {
  photo: PhotoMeta;
  aspectRatio: number;
  tentativeWidth: number;
  hasGps: boolean;
  hasDescription: boolean;
  descriptionLength: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TARGET_ROW_HEIGHT = 220;
const DEFAULT_GAP = 4;
const DEFAULT_MIN_PHOTO_WIDTH = 80;
const DEFAULT_MAX_HEIGHT_MULTIPLIER = 2.0;
const DEFAULT_MIN_HEIGHT_MULTIPLIER = 0.5;
const DEFAULT_MIN_DESCRIPTION_LENGTH = 20;
const DEFAULT_MIN_PHOTOS_FOR_MAP = 3;
const DEFAULT_ASPECT_RATIO = 4 / 3;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate aspect ratio for a photo
 * Falls back to 4:3 if dimensions not available
 */
function getAspectRatio(photo: PhotoMeta): number {
  if (photo.width && photo.height && photo.height > 0) {
    return photo.width / photo.height;
  }
  return DEFAULT_ASPECT_RATIO;
}

/**
 * Check if a photo is portrait orientation
 */
function isPortrait(photo: PhotoMeta): boolean {
  return photo.height > photo.width;
}

/**
 * Check if a photo has GPS coordinates
 */
function hasGpsCoordinates(photo: PhotoMeta): boolean {
  return photo.lat != null && photo.lng != null;
}

/**
 * Check if a photo has a meaningful description
 */
function hasMeaningfulDescription(
  photo: PhotoMeta,
  minLength: number,
): boolean {
  return !!photo.description && photo.description.trim().length >= minLength;
}

/**
 * Normalize photos with pre-calculated values
 */
function normalizePhotos(
  photos: PhotoMeta[],
  targetRowHeight: number,
  minDescriptionLength: number,
): NormalizedPhoto[] {
  return photos.map((photo) => {
    const aspectRatio = getAspectRatio(photo);
    return {
      photo,
      aspectRatio,
      tentativeWidth: aspectRatio * targetRowHeight,
      hasGps: hasGpsCoordinates(photo),
      hasDescription: hasMeaningfulDescription(photo, minDescriptionLength),
      descriptionLength: photo.description?.trim().length ?? 0,
    };
  });
}

/**
 * Calculate the exact row height that makes photos fit the container width
 *
 * Formula: NewHeight = (ContainerWidth - TotalGaps) / SumOfAspectRatios
 */
function calculateJustifiedRowHeight(
  aspectRatios: number[],
  containerWidth: number,
  gap: number,
): number {
  const sumOfAspectRatios = aspectRatios.reduce((sum, ar) => sum + ar, 0);
  if (sumOfAspectRatios === 0) return 0;

  const totalGaps = (aspectRatios.length - 1) * gap;
  const availableWidth = containerWidth - totalGaps;

  return availableWidth / sumOfAspectRatios;
}

/**
 * Check if a GPS cluster is meaningful (photos are geographically close enough)
 */
function isGpsClusterMeaningful(
  coordinates: Array<{ lat: number; lng: number; photoId: string }>,
): boolean {
  if (coordinates.length < 2) return true; // Single point is always "clustered"

  // Calculate bounding box
  const lats = coordinates.map((c) => c.lat);
  const lngs = coordinates.map((c) => c.lng);
  const latSpread = Math.max(...lats) - Math.min(...lats);
  const lngSpread = Math.max(...lngs) - Math.min(...lngs);

  // If spread is less than ~50km in any direction, consider it a meaningful cluster
  // Rough approximation: 1 degree ≈ 111km
  const maxSpreadDegrees = 0.5; // ~55km
  return latSpread <= maxSpreadDegrees || lngSpread <= maxSpreadDegrees;
}

// ============================================================================
// Row Building Strategies
// ============================================================================

/**
 * Build a standard justified row from photos
 */
function buildJustifiedRow(
  photos: NormalizedPhoto[],
  containerWidth: number,
  gap: number,
  targetRowHeight: number,
  maxHeightMultiplier: number,
  minHeightMultiplier: number,
  top: number,
  isOrphan: boolean = false,
): LayoutRow {
  if (photos.length === 0) {
    return { height: 0, items: [], top, isOrphan };
  }

  const aspectRatios = photos.map((p) => p.aspectRatio);

  let rowHeight: number;
  if (isOrphan) {
    // Orphan row: keep target height, don't stretch
    rowHeight = targetRowHeight;
  } else {
    // Justified row: calculate exact height to fill width
    rowHeight = calculateJustifiedRowHeight(aspectRatios, containerWidth, gap);

    // Clamp to reasonable bounds
    const maxHeight = targetRowHeight * maxHeightMultiplier;
    const minHeight = targetRowHeight * minHeightMultiplier;
    rowHeight = Math.min(Math.max(rowHeight, minHeight), maxHeight);
  }

  // Calculate photo widths
  let currentLeft = 0;
  const items: EnhancedMosaicItem[] = [];

  for (let i = 0; i < photos.length; i++) {
    const normalizedPhoto = photos[i];
    if (!normalizedPhoto) continue;

    const { photo, aspectRatio } = normalizedPhoto;
    let itemWidth = Math.floor(aspectRatio * rowHeight);

    // For non-orphan rows, adjust last photo to fill remaining space exactly
    if (!isOrphan && i === photos.length - 1) {
      const usedWidth = currentLeft;
      const remainingWidth = containerWidth - usedWidth;
      itemWidth = Math.floor(remainingWidth);
    }

    items.push({
      id: photo.id,
      photoId: photo.id,
      type: 'standard',
      isPortrait: isPortrait(photo),
      rect: {
        top,
        left: currentLeft,
        width: itemWidth,
        height: Math.floor(rowHeight),
      },
    });

    currentLeft += itemWidth + gap;
  }

  return {
    height: Math.floor(rowHeight),
    items,
    top,
    isOrphan,
  };
}

/**
 * Build a story row (photo + description side by side)
 */
function buildStoryRow(
  normalizedPhoto: NormalizedPhoto,
  containerWidth: number,
  targetRowHeight: number,
  top: number,
): LayoutRow {
  const height = Math.floor(targetRowHeight * 1.5);

  return {
    height,
    items: [
      {
        id: normalizedPhoto.photo.id,
        photoId: normalizedPhoto.photo.id,
        type: 'story',
        description: normalizedPhoto.photo.description || '',
        rect: {
          top,
          left: 0,
          width: containerWidth,
          height,
        },
      },
    ],
    top,
  };
}

/**
 * Build a map cluster row showing photo locations
 */
function buildMapRow(
  photosWithGps: NormalizedPhoto[],
  containerWidth: number,
  targetRowHeight: number,
  gap: number,
  top: number,
): LayoutRow {
  const coordinates = photosWithGps
    .filter((p) => p.hasGps)
    .map((p) => ({
      lat: p.photo.lat!,
      lng: p.photo.lng!,
      photoId: p.photo.id,
    }));

  // Only create map if cluster is meaningful
  if (!isGpsClusterMeaningful(coordinates)) {
    return { height: 0, items: [], top };
  }

  const mapWidth = Math.floor(containerWidth * 0.4);
  const photosWidth = containerWidth - mapWidth - gap;
  const height = Math.floor(targetRowHeight * 1.8);

  const items: EnhancedMosaicItem[] = [];

  // Add map tile
  items.push({
    id: `map-${photosWithGps[0]?.photo.id || 'unknown'}`,
    type: 'map-cluster',
    coordinates,
    associatedPhotoIds: photosWithGps.map((p) => p.photo.id),
    rect: {
      top,
      left: 0,
      width: mapWidth,
      height,
    },
  });

  // Add photos on the right side
  // Calculate justified layout for the remaining photos in the smaller space
  const photoAspectRatios = photosWithGps.map((p) => p.aspectRatio);
  const availablePhotoWidth = photosWidth;
  const numPhotos = photosWithGps.length;

  // Stack photos vertically if more than 2
  if (numPhotos <= 2) {
    // Horizontal layout
    const photoHeight = calculateJustifiedRowHeight(
      photoAspectRatios,
      availablePhotoWidth,
      gap,
    );
    const clampedHeight = Math.min(photoHeight, height);

    let currentLeft = mapWidth + gap;
    for (const normalizedPhoto of photosWithGps) {
      const photoWidth = Math.floor(
        normalizedPhoto.aspectRatio * clampedHeight,
      );
      items.push({
        id: normalizedPhoto.photo.id,
        photoId: normalizedPhoto.photo.id,
        type: 'standard',
        rect: {
          top,
          left: currentLeft,
          width: photoWidth,
          height: Math.floor(clampedHeight),
        },
      });
      currentLeft += photoWidth + gap;
    }
  } else {
    // 2-column grid for more photos
    const cols = 2;
    const rows = Math.ceil(numPhotos / cols);
    const cellWidth = Math.floor(
      (availablePhotoWidth - (cols - 1) * gap) / cols,
    );
    const cellHeight = Math.floor((height - (rows - 1) * gap) / rows);

    for (let i = 0; i < photosWithGps.length; i++) {
      const normalizedPhoto = photosWithGps[i];
      if (!normalizedPhoto) continue;

      const col = i % cols;
      const row = Math.floor(i / cols);

      items.push({
        id: normalizedPhoto.photo.id,
        photoId: normalizedPhoto.photo.id,
        type: 'standard',
        rect: {
          top: top + row * (cellHeight + gap),
          left: mapWidth + gap + col * (cellWidth + gap),
          width: cellWidth,
          height: cellHeight,
        },
      });
    }
  }

  return { height, items, top };
}

// ============================================================================
// Main Layout Algorithm
// ============================================================================

/**
 * Compute the enhanced mosaic layout for a list of photos
 *
 * The algorithm:
 * 1. Normalize all photos with aspect ratios and metadata
 * 2. Process photos in batches to form rows
 * 3. Detect opportunities for special tiles (story, map)
 * 4. Build justified rows that fill container width exactly
 * 5. Handle orphan (last) row without stretching
 */
export function computeEnhancedMosaicLayout(
  photos: PhotoMeta[],
  config: MosaicLayoutConfig,
): EnhancedMosaicItem[] {
  const {
    containerWidth,
    targetRowHeight = DEFAULT_TARGET_ROW_HEIGHT,
    gap = DEFAULT_GAP,
    minPhotoWidth: _minPhotoWidth = DEFAULT_MIN_PHOTO_WIDTH,
    maxRowHeightMultiplier = DEFAULT_MAX_HEIGHT_MULTIPLIER,
    minRowHeightMultiplier = DEFAULT_MIN_HEIGHT_MULTIPLIER,
    enableMapTiles = true,
    enableDescriptionTiles = true,
    minDescriptionLength = DEFAULT_MIN_DESCRIPTION_LENGTH,
    minPhotosForMapTile = DEFAULT_MIN_PHOTOS_FOR_MAP,
  } = config;

  if (photos.length === 0 || containerWidth <= 0) {
    return [];
  }

  // Step 1: Normalize photos
  const normalized = normalizePhotos(
    photos,
    targetRowHeight,
    minDescriptionLength,
  );

  const allItems: EnhancedMosaicItem[] = [];
  let currentTop = 0;
  let cursor = 0;

  while (cursor < normalized.length) {
    const currentPhoto = normalized[cursor];
    if (!currentPhoto) break;

    const remaining = normalized.length - cursor;

    // Strategy 1: Check for description tile opportunity
    if (enableDescriptionTiles && currentPhoto.hasDescription) {
      const row = buildStoryRow(
        currentPhoto,
        containerWidth,
        targetRowHeight,
        currentTop,
      );
      allItems.push(...row.items);
      currentTop += row.height + gap;
      cursor += 1;
      continue;
    }

    // Strategy 2: Check for map cluster opportunity
    // Look ahead to see if we have enough GPS-tagged photos
    if (enableMapTiles) {
      const lookahead = Math.min(remaining, 6);
      const gpsPhotos: NormalizedPhoto[] = [];

      for (let i = 0; i < lookahead; i++) {
        const photo = normalized[cursor + i];
        if (photo?.hasGps) {
          gpsPhotos.push(photo);
        }
      }

      if (gpsPhotos.length >= minPhotosForMapTile) {
        const row = buildMapRow(
          gpsPhotos,
          containerWidth,
          targetRowHeight,
          gap,
          currentTop,
        );
        if (row.items.length > 0) {
          allItems.push(...row.items);
          currentTop += row.height + gap;
          cursor += gpsPhotos.length;
          continue;
        }
      }
    }

    // Strategy 3: Build a standard justified row
    // Add photos until we exceed container width
    const rowPhotos: NormalizedPhoto[] = [];
    let tentativeWidthSum = 0;

    while (cursor + rowPhotos.length < normalized.length) {
      const photo = normalized[cursor + rowPhotos.length];
      if (!photo) break;

      // Skip photos with descriptions (they get their own rows)
      if (enableDescriptionTiles && photo.hasDescription) break;

      tentativeWidthSum += photo.tentativeWidth;
      rowPhotos.push(photo);

      // Account for gaps
      const totalGaps = (rowPhotos.length - 1) * gap;

      // Check if we've filled the row
      if (tentativeWidthSum + totalGaps >= containerWidth) {
        break;
      }

      // Don't add too many photos to a single row
      if (rowPhotos.length >= 6) break;
    }

    // Determine if this is an orphan row (last row that won't fill width)
    const isLastRow = cursor + rowPhotos.length >= normalized.length;
    const totalGaps = (rowPhotos.length - 1) * gap;
    const fillRatio = (tentativeWidthSum + totalGaps) / containerWidth;
    const isOrphan = isLastRow && fillRatio < 0.8;

    const row = buildJustifiedRow(
      rowPhotos,
      containerWidth,
      gap,
      targetRowHeight,
      maxRowHeightMultiplier,
      minRowHeightMultiplier,
      currentTop,
      isOrphan,
    );

    allItems.push(...row.items);
    currentTop += row.height + gap;
    cursor += rowPhotos.length;
  }

  return allItems;
}

/**
 * Compute layout grouped by rows for virtualization
 */
export function computeEnhancedMosaicRows(
  photos: PhotoMeta[],
  config: MosaicLayoutConfig,
): LayoutRow[] {
  const items = computeEnhancedMosaicLayout(photos, config);

  // Group items by their top coordinate
  const byTop = new Map<number, EnhancedMosaicItem[]>();
  for (const item of items) {
    const top = item.rect.top;
    if (!byTop.has(top)) {
      byTop.set(top, []);
    }
    byTop.get(top)!.push(item);
  }

  // Convert to rows
  const rows: LayoutRow[] = [];
  const sortedTops = Array.from(byTop.keys()).sort((a, b) => a - b);

  for (const top of sortedTops) {
    const rowItems = byTop.get(top)!;
    let maxHeight = 0;

    for (const item of rowItems) {
      const itemBottom = item.rect.top + item.rect.height - top;
      if (itemBottom > maxHeight) {
        maxHeight = itemBottom;
      }
    }

    rows.push({
      height: maxHeight,
      items: rowItems.map((item) => ({
        ...item,
        rect: {
          ...item.rect,
          top: item.rect.top - top, // Make position relative to row
        },
      })),
      top,
    });
  }

  return rows;
}

/**
 * Calculate total height of the layout
 */
export function getTotalLayoutHeight(
  items: EnhancedMosaicItem[],
  _gap: number = DEFAULT_GAP,
): number {
  if (items.length === 0) return 0;

  let maxBottom = 0;
  for (const item of items) {
    const bottom = item.rect.top + item.rect.height;
    if (bottom > maxBottom) {
      maxBottom = bottom;
    }
  }

  return maxBottom;
}
