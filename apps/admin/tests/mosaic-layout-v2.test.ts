/**
 * Tests for the Enhanced Mosaic Layout Algorithm (v2)
 * 
 * Tests cover:
 * - Justified row calculation with proper math
 * - Orphan (last row) handling
 * - Smart map tile insertion
 * - Smart description tile insertion
 * - Edge cases (empty input, single photo, etc.)
 */

import { describe, it, expect } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';
import {
  computeEnhancedMosaicLayout,
  computeEnhancedMosaicRows,
  getTotalLayoutHeight,
  type MosaicLayoutConfig,
  type EnhancedMosaicItem,
} from '../src/lib/mosaic-layout-v2';

// ============================================================================
// Test Fixtures
// ============================================================================

function createPhoto(overrides: Partial<PhotoMeta> & { id: string }): PhotoMeta {
  return {
    assetId: overrides.id,
    albumId: 'test-album',
    filename: `${overrides.id}.jpg`,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 1200,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    shardIds: [],
    epochId: 1,
    ...overrides,
  };
}

function createLandscapePhoto(id: string, aspectRatio: number = 1.5): PhotoMeta {
  return createPhoto({
    id,
    width: Math.round(1200 * aspectRatio),
    height: 1200,
  });
}

function createPortraitPhoto(id: string, aspectRatio: number = 0.67): PhotoMeta {
  return createPhoto({
    id,
    width: Math.round(1200 * aspectRatio),
    height: 1200,
  });
}

function createSquarePhoto(id: string): PhotoMeta {
  return createPhoto({
    id,
    width: 1200,
    height: 1200,
  });
}

function createPhotoWithGps(id: string, lat: number, lng: number): PhotoMeta {
  return createPhoto({
    id,
    lat,
    lng,
  });
}

function createPhotoWithDescription(id: string, description: string): PhotoMeta {
  return createPhoto({
    id,
    description,
  });
}

const defaultConfig: MosaicLayoutConfig = {
  containerWidth: 1000,
  targetRowHeight: 200,
  gap: 4,
  enableMapTiles: false,
  enableDescriptionTiles: false,
};

// ============================================================================
// Algorithm Validation Tests
// ============================================================================

describe('Enhanced Mosaic Layout - Justified Row Algorithm', () => {
  
  describe('Basic Justified Layout', () => {
    
    it('should handle empty input', () => {
      const items = computeEnhancedMosaicLayout([], defaultConfig);
      expect(items).toEqual([]);
    });

    it('should handle single photo', () => {
      const photos = [createLandscapePhoto('photo-1', 1.5)];
      const items = computeEnhancedMosaicLayout(photos, defaultConfig);
      
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('photo-1');
      expect(items[0].type).toBe('standard');
    });

    it('should correctly calculate justified row height using the formula', () => {
      // Test case from the algorithm spec:
      // Container: 1000px, Target: 200px, No margins
      // Images: A(AR=1.5), B(AR=1.5), C(AR=1.0), D(AR=0.5)
      // Sum of ARs = 4.5
      // New Height = 1000 / 4.5 = 222.22px (approximately)
      
      const photos = [
        createPhoto({ id: 'A', width: 1500, height: 1000 }), // AR = 1.5
        createPhoto({ id: 'B', width: 1500, height: 1000 }), // AR = 1.5
        createPhoto({ id: 'C', width: 1000, height: 1000 }), // AR = 1.0
        createPhoto({ id: 'D', width: 500, height: 1000 }),  // AR = 0.5
      ];
      
      const config: MosaicLayoutConfig = {
        containerWidth: 1000,
        targetRowHeight: 200,
        gap: 0, // No gaps for exact calculation
        enableMapTiles: false,
        enableDescriptionTiles: false,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // With gap=0: NewHeight = 1000 / (1.5 + 1.5 + 1.0 + 0.5) = 1000 / 4.5 ≈ 222
      // All photos should have the same height
      const heights = items.map(item => item.rect.height);
      const uniqueHeights = new Set(heights);
      expect(uniqueHeights.size).toBe(1);
      
      // Verify the justified height calculation
      const rowHeight = items[0].rect.height;
      expect(rowHeight).toBeGreaterThan(200); // Should be stretched to fill
      expect(rowHeight).toBeLessThan(250); // But not excessively
      
      // Verify widths are proportional to aspect ratios
      const itemA = items.find(i => i.id === 'A');
      const itemD = items.find(i => i.id === 'D');
      expect(itemA?.rect.width).toBeGreaterThan(itemD?.rect.width ?? 0);
      
      // Width of A should be ~3x width of D (AR 1.5 vs AR 0.5)
      const widthRatio = (itemA?.rect.width ?? 0) / (itemD?.rect.width ?? 1);
      expect(widthRatio).toBeCloseTo(3.0, 0.5);
    });

    it('should account for gaps in justified calculation', () => {
      const photos = [
        createPhoto({ id: 'A', width: 1500, height: 1000 }), // AR = 1.5
        createPhoto({ id: 'B', width: 1500, height: 1000 }), // AR = 1.5
        createPhoto({ id: 'C', width: 1000, height: 1000 }), // AR = 1.0
      ];
      
      const configWithGaps: MosaicLayoutConfig = {
        containerWidth: 1000,
        targetRowHeight: 200,
        gap: 10, // 10px gaps
        enableMapTiles: false,
        enableDescriptionTiles: false,
      };
      
      const items = computeEnhancedMosaicLayout(photos, configWithGaps);
      
      // With 3 photos and gap=10, we have 2 gaps = 20px
      // Available width = 1000 - 20 = 980px
      // Sum of ARs = 4.0
      // NewHeight = 980 / 4.0 = 245px
      
      const rowHeight = items[0].rect.height;
      expect(rowHeight).toBeGreaterThan(200);
      
      // Verify total width including gaps equals container width
      const totalWidthWithGaps = items.reduce((sum, item, i) => {
        return sum + item.rect.width + (i < items.length - 1 ? 10 : 0);
      }, 0);
      expect(totalWidthWithGaps).toBeLessThanOrEqual(1000);
    });

    it('should fill container width exactly for complete rows', () => {
      const photos = [
        createLandscapePhoto('photo-1', 1.5),
        createLandscapePhoto('photo-2', 1.5),
        createSquarePhoto('photo-3'),
      ];
      
      const items = computeEnhancedMosaicLayout(photos, defaultConfig);
      
      // Calculate total width of items
      const totalWidth = items.reduce((sum, item, i) => {
        return sum + item.rect.width + (i < items.length - 1 ? defaultConfig.gap : 0);
      }, 0);
      
      // Should fill container width (allowing for rounding)
      expect(totalWidth).toBeGreaterThanOrEqual(defaultConfig.containerWidth - 5);
      expect(totalWidth).toBeLessThanOrEqual(defaultConfig.containerWidth + 5);
    });
  });

  describe('Multi-Row Layout', () => {
    
    it('should create multiple rows when photos exceed container width', () => {
      // Create many photos that will require multiple rows
      const photos = [
        createLandscapePhoto('p1', 2.0),
        createLandscapePhoto('p2', 2.0),
        createLandscapePhoto('p3', 2.0),
        createLandscapePhoto('p4', 2.0),
        createLandscapePhoto('p5', 2.0),
        createLandscapePhoto('p6', 2.0),
      ];
      
      const items = computeEnhancedMosaicLayout(photos, defaultConfig);
      expect(items).toHaveLength(6);
      
      // Check that we have multiple unique top positions (multiple rows)
      const uniqueTops = new Set(items.map(item => item.rect.top));
      expect(uniqueTops.size).toBeGreaterThan(1);
    });

    it('should group items into rows correctly', () => {
      const photos = [
        createLandscapePhoto('p1', 1.5),
        createLandscapePhoto('p2', 1.5),
        createLandscapePhoto('p3', 1.5),
        createLandscapePhoto('p4', 1.5),
      ];
      
      const rows = computeEnhancedMosaicRows(photos, defaultConfig);
      
      // Should have at least 1 row
      expect(rows.length).toBeGreaterThan(0);
      
      // Each row should have items
      for (const row of rows) {
        expect(row.items.length).toBeGreaterThan(0);
        expect(row.height).toBeGreaterThan(0);
      }
    });
  });

  describe('Orphan Row Handling', () => {
    
    it('should not stretch orphan rows', () => {
      // Create photos where the last row will be sparse
      const photos = [
        createLandscapePhoto('p1', 2.0),
        createLandscapePhoto('p2', 2.0),
        createLandscapePhoto('p3', 2.0),
        createPortraitPhoto('orphan', 0.5), // Single portrait that won't fill width
      ];
      
      const config: MosaicLayoutConfig = {
        containerWidth: 1000,
        targetRowHeight: 200,
        gap: 4,
        enableMapTiles: false,
        enableDescriptionTiles: false,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      const rows = computeEnhancedMosaicRows(photos, config);
      
      // Last row should exist
      expect(rows.length).toBeGreaterThan(0);
      const lastRow = rows[rows.length - 1];
      
      // If it's an orphan row, height should be close to target height
      // (not stretched to fill width)
      if (lastRow.isOrphan) {
        expect(lastRow.height).toBeCloseTo(200, -1); // Within 10 pixels
      }
    });

    it('should detect orphan rows based on fill ratio', () => {
      // Single small photo - should be orphan
      const photos = [createPortraitPhoto('lonely', 0.5)];
      
      const items = computeEnhancedMosaicLayout(photos, defaultConfig);
      
      // With AR=0.5 and targetHeight=200, tentativeWidth=100
      // This is only 10% of 1000px container, definitely orphan
      expect(items).toHaveLength(1);
      
      // Height should be close to target (not stretched)
      expect(items[0].rect.height).toBeCloseTo(200, -1);
    });
  });
});

// ============================================================================
// Smart Tile Insertion Tests
// ============================================================================

describe('Enhanced Mosaic Layout - Smart Tiles', () => {
  
  describe('Description Tile Insertion', () => {
    
    it('should create story tiles for photos with descriptions', () => {
      const photos = [
        createPhotoWithDescription('story-photo', 'This is a meaningful description that tells a story about this particular photo and provides context.'),
        createLandscapePhoto('normal-1', 1.5),
        createLandscapePhoto('normal-2', 1.5),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableDescriptionTiles: true,
        minDescriptionLength: 20,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // First photo should be a story tile
      const storyItem = items.find(item => item.id === 'story-photo');
      expect(storyItem?.type).toBe('story');
      expect(storyItem?.description).toContain('meaningful description');
    });

    it('should not create story tiles for short descriptions', () => {
      const photos = [
        createPhotoWithDescription('short-desc', 'Hello'),
        createLandscapePhoto('normal-1', 1.5),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableDescriptionTiles: true,
        minDescriptionLength: 20,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // Photo with short description should be standard
      const item = items.find(item => item.id === 'short-desc');
      expect(item?.type).toBe('standard');
    });

    it('should skip description tiles when disabled', () => {
      const photos = [
        createPhotoWithDescription('story-photo', 'This is a long meaningful description.'),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableDescriptionTiles: false,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // Should be standard tile, not story
      expect(items[0].type).toBe('standard');
    });
  });

  describe('Map Tile Insertion', () => {
    
    it('should create map cluster tiles for GPS-tagged photos', () => {
      const photos = [
        createPhotoWithGps('gps-1', 40.7128, -74.0060), // NYC
        createPhotoWithGps('gps-2', 40.7129, -74.0061),
        createPhotoWithGps('gps-3', 40.7130, -74.0062),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableMapTiles: true,
        minPhotosForMapTile: 3,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // Should have a map tile
      const mapItem = items.find(item => item.type === 'map-cluster');
      expect(mapItem).toBeDefined();
      expect(mapItem?.coordinates).toHaveLength(3);
    });

    it('should not create map tiles with insufficient GPS photos', () => {
      const photos = [
        createPhotoWithGps('gps-1', 40.7128, -74.0060),
        createPhotoWithGps('gps-2', 40.7129, -74.0061),
        createLandscapePhoto('no-gps', 1.5),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableMapTiles: true,
        minPhotosForMapTile: 3, // Need 3, only have 2
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // Should not have a map tile
      const mapItem = items.find(item => item.type === 'map-cluster');
      expect(mapItem).toBeUndefined();
    });

    it('should skip map tiles when disabled', () => {
      const photos = [
        createPhotoWithGps('gps-1', 40.7128, -74.0060),
        createPhotoWithGps('gps-2', 40.7129, -74.0061),
        createPhotoWithGps('gps-3', 40.7130, -74.0062),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableMapTiles: false,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      
      // Should not have any map tiles
      const mapItem = items.find(item => item.type === 'map-cluster');
      expect(mapItem).toBeUndefined();
    });

    it('should include associated photo IDs in map tiles', () => {
      const photos = [
        createPhotoWithGps('gps-1', 40.7128, -74.0060),
        createPhotoWithGps('gps-2', 40.7129, -74.0061),
        createPhotoWithGps('gps-3', 40.7130, -74.0062),
      ];
      
      const config: MosaicLayoutConfig = {
        ...defaultConfig,
        enableMapTiles: true,
        minPhotosForMapTile: 3,
      };
      
      const items = computeEnhancedMosaicLayout(photos, config);
      const mapItem = items.find(item => item.type === 'map-cluster');
      
      expect(mapItem?.associatedPhotoIds).toContain('gps-1');
      expect(mapItem?.associatedPhotoIds).toContain('gps-2');
      expect(mapItem?.associatedPhotoIds).toContain('gps-3');
    });
  });
});

// ============================================================================
// Height Calculation Tests
// ============================================================================

describe('Enhanced Mosaic Layout - Height Calculations', () => {
  
  it('should calculate total layout height correctly', () => {
    const photos = [
      createLandscapePhoto('p1', 1.5),
      createLandscapePhoto('p2', 1.5),
      createLandscapePhoto('p3', 1.5),
    ];
    
    const items = computeEnhancedMosaicLayout(photos, defaultConfig);
    const totalHeight = getTotalLayoutHeight(items, defaultConfig.gap);
    
    // Total height should be the bottom of the lowest item
    expect(totalHeight).toBeGreaterThan(0);
    
    // All items should be within the total height
    for (const item of items) {
      expect(item.rect.top + item.rect.height).toBeLessThanOrEqual(totalHeight);
    }
  });

  it('should return 0 height for empty layout', () => {
    const totalHeight = getTotalLayoutHeight([], 4);
    expect(totalHeight).toBe(0);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Enhanced Mosaic Layout - Edge Cases', () => {
  
  it('should handle photos with missing dimensions', () => {
    const photos = [
      createPhoto({ id: 'no-dims', width: 0, height: 0 }),
      createLandscapePhoto('normal', 1.5),
    ];
    
    // Should not throw
    const items = computeEnhancedMosaicLayout(photos, defaultConfig);
    expect(items.length).toBeGreaterThan(0);
  });

  it('should handle container width of 0', () => {
    const photos = [createLandscapePhoto('photo', 1.5)];
    
    const config: MosaicLayoutConfig = {
      ...defaultConfig,
      containerWidth: 0,
    };
    
    const items = computeEnhancedMosaicLayout(photos, config);
    expect(items).toEqual([]);
  });

  it('should handle negative container width', () => {
    const photos = [createLandscapePhoto('photo', 1.5)];
    
    const config: MosaicLayoutConfig = {
      ...defaultConfig,
      containerWidth: -100,
    };
    
    const items = computeEnhancedMosaicLayout(photos, config);
    expect(items).toEqual([]);
  });

  it('should handle extremely wide photos', () => {
    const photos = [
      createPhoto({ id: 'panorama', width: 10000, height: 1000 }), // AR = 10
    ];
    
    const items = computeEnhancedMosaicLayout(photos, defaultConfig);
    
    // Should handle gracefully
    expect(items).toHaveLength(1);
    expect(items[0].rect.width).toBeLessThanOrEqual(defaultConfig.containerWidth);
  });

  it('should handle extremely tall photos', () => {
    const photos = [
      createPhoto({ id: 'tall', width: 500, height: 5000 }), // AR = 0.1
    ];
    
    const items = computeEnhancedMosaicLayout(photos, defaultConfig);
    
    // Should handle gracefully
    expect(items).toHaveLength(1);
    expect(items[0].rect.height).toBeGreaterThan(0);
  });

  it('should handle many photos efficiently', () => {
    const photos = Array.from({ length: 100 }, (_, i) => 
      createLandscapePhoto(`photo-${i}`, 1 + Math.random())
    );
    
    const startTime = performance.now();
    const items = computeEnhancedMosaicLayout(photos, defaultConfig);
    const endTime = performance.now();
    
    expect(items).toHaveLength(100);
    expect(endTime - startTime).toBeLessThan(100); // Should complete in <100ms
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Enhanced Mosaic Layout - Integration', () => {
  
  it('should create a realistic mixed layout with story and map tiles', () => {
    // Note: Photos with descriptions get story tiles first, then GPS clusters get map tiles
    // The landscape photos without GPS/description go into standard rows
    const photos = [
      createPhotoWithDescription('story-1', 'This is a beautiful sunset photo taken during our vacation to the beach. The colors were amazing!'),
      createPhotoWithGps('gps-1', 40.7128, -74.0060),
      createPhotoWithGps('gps-2', 40.7129, -74.0061),
      createPhotoWithGps('gps-3', 40.7130, -74.0062),
      createLandscapePhoto('landscape-1', 1.5),
      createLandscapePhoto('landscape-2', 1.8),
      createPortraitPhoto('portrait-1', 0.67),
      createPortraitPhoto('portrait-2', 0.67),
      createSquarePhoto('square-1'),
    ];
    
    const config: MosaicLayoutConfig = {
      containerWidth: 1200,
      targetRowHeight: 250,
      gap: 8,
      enableMapTiles: true,
      enableDescriptionTiles: true,
      minDescriptionLength: 20,
      minPhotosForMapTile: 3,
    };
    
    const items = computeEnhancedMosaicLayout(photos, config);
    
    // Should have all photos accounted for
    const photoIds = items
      .filter(item => item.photoId)
      .map(item => item.photoId);
    expect(photoIds).toContain('story-1');
    
    // Standard landscape photos should be included
    expect(photoIds).toContain('landscape-1');
    expect(photoIds).toContain('landscape-2');
    
    // Should have story tile
    const storyTile = items.find(item => item.type === 'story');
    expect(storyTile).toBeDefined();
    expect(storyTile?.description).toContain('beautiful sunset');
    
    // Should have map tile with coordinates
    const mapTile = items.find(item => item.type === 'map-cluster');
    expect(mapTile).toBeDefined();
    expect(mapTile?.coordinates).toHaveLength(3);
    
    // No items should overlap horizontally within the same row
    const rows = computeEnhancedMosaicRows(photos, config);
    for (const row of rows) {
      const sortedItems = [...row.items].sort((a, b) => a.rect.left - b.rect.left);
      for (let i = 1; i < sortedItems.length; i++) {
        const prev = sortedItems[i - 1];
        const curr = sortedItems[i];
        expect(prev.rect.left + prev.rect.width).toBeLessThanOrEqual(curr.rect.left);
      }
    }
    
    // Verify total photos in layout
    // Story tile = 1, Map tile has 3 associated photos, remaining 5 standard photos
    expect(items.length).toBeGreaterThanOrEqual(photos.length);
  });

  it('should handle layout without special tiles', () => {
    const photos = [
      createLandscapePhoto('l1', 1.5),
      createLandscapePhoto('l2', 1.8),
      createPortraitPhoto('p1', 0.67),
      createSquarePhoto('s1'),
    ];
    
    const config: MosaicLayoutConfig = {
      containerWidth: 1000,
      targetRowHeight: 200,
      gap: 4,
      enableMapTiles: false,
      enableDescriptionTiles: false,
    };
    
    const items = computeEnhancedMosaicLayout(photos, config);
    
    // All should be standard tiles
    for (const item of items) {
      expect(item.type).toBe('standard');
    }
    
    // All photos should be present
    expect(items).toHaveLength(photos.length);
    
    const photoIds = items.map(item => item.photoId);
    expect(photoIds).toContain('l1');
    expect(photoIds).toContain('l2');
    expect(photoIds).toContain('p1');
    expect(photoIds).toContain('s1');
  });
});
