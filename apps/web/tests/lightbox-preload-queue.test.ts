/**
 * Lightbox Preload Queue Tests
 *
 * Tests the direction-aware preload queue generation logic.
 * This logic determines which photos to preload based on:
 * - Current photo index
 * - Navigation direction (forward, backward, initial)
 * - Array boundaries
 * - Photo validity (must have shardIds)
 *
 * The preload strategy is:
 * - Initial (just opened): preload ±1, ±2 (up to 4 photos)
 * - Forward navigation: preload +1, +2, then -1 (prioritize ahead)
 * - Backward navigation: preload -1, -2, then +1 (prioritize behind)
 */

import { describe, expect, it } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';
import type { NavigationDirection } from '../src/hooks/useLightbox';

const PRELOAD_COUNT = 2;

/**
 * Generate a preload queue based on current index and navigation direction.
 * This mirrors the logic in MosaicPhotoGrid.tsx and other grid components.
 *
 * @param sortedPhotos - Array of all photos in display order
 * @param currentIdx - Current photo index
 * @param direction - Navigation direction
 * @returns Array of photos to preload
 */
function generatePreloadQueue(
  sortedPhotos: PhotoMeta[],
  currentIdx: number,
  direction: NavigationDirection,
): PhotoMeta[] {
  const queue: PhotoMeta[] = [];

  if (direction === 'forward') {
    // Moving forward: prioritize ahead, then add one behind
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const next = sortedPhotos[currentIdx + offset];
      if (next?.shardIds?.length) queue.push(next);
    }
    // Also preload one behind in case user goes back
    const prev = sortedPhotos[currentIdx - 1];
    if (prev?.shardIds?.length) queue.push(prev);
  } else if (direction === 'backward') {
    // Moving backward: prioritize behind, then add one ahead
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prev = sortedPhotos[currentIdx - offset];
      if (prev?.shardIds?.length) queue.push(prev);
    }
    // Also preload one ahead in case user goes forward
    const next = sortedPhotos[currentIdx + 1];
    if (next?.shardIds?.length) queue.push(next);
  } else {
    // Initial open: preload equally in both directions
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const next = sortedPhotos[currentIdx + offset];
      const prev = sortedPhotos[currentIdx - offset];
      if (next?.shardIds?.length) queue.push(next);
      if (prev?.shardIds?.length) queue.push(prev);
    }
  }

  return queue;
}

// Helper to create mock photos
function createMockPhotos(count: number): PhotoMeta[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `photo-${i}`,
    assetId: `asset-${i}`,
    albumId: 'album-1',
    epochId: 1,
    filename: `photo-${i}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    shardIds: [`shard-${i}`],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tags: [],
  }));
}

// Helper to create a photo without shardIds
function createPhotoWithoutShards(index: number): PhotoMeta {
  return {
    id: `photo-${index}`,
    assetId: `asset-${index}`,
    albumId: 'album-1',
    epochId: 1,
    filename: `photo-${index}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    shardIds: [], // Empty - should be skipped
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tags: [],
  };
}

describe('Lightbox Preload Queue Generation', () => {
  describe('initial open (direction = "initial")', () => {
    it('preloads adjacent photos when lightbox opens in the middle', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 5, 'initial');

      // Should preload: +1 (6), -1 (4), +2 (7), -2 (3)
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-6'); // +1
      expect(ids).toContain('photo-4'); // -1
      expect(ids).toContain('photo-7'); // +2
      expect(ids).toContain('photo-3'); // -2
      expect(queue).toHaveLength(4);
    });

    it('preloads in correct order: next, prev alternating', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 5, 'initial');

      // Order should be: +1, -1, +2, -2 (alternating)
      expect(queue[0]?.id).toBe('photo-6'); // +1
      expect(queue[1]?.id).toBe('photo-4'); // -1
      expect(queue[2]?.id).toBe('photo-7'); // +2
      expect(queue[3]?.id).toBe('photo-3'); // -2
    });
  });

  describe('forward navigation (direction = "forward")', () => {
    it('prioritizes photos ahead when navigating forward', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 5, 'forward');

      // Should preload: +1 (6), +2 (7), then -1 (4)
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-6'); // +1 (priority)
      expect(ids).toContain('photo-7'); // +2 (priority)
      expect(ids).toContain('photo-4'); // -1 (fallback)
      expect(queue).toHaveLength(3);
    });

    it('puts forward photos first in the queue', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 5, 'forward');

      // First two should be forward photos
      expect(queue[0]?.id).toBe('photo-6'); // +1
      expect(queue[1]?.id).toBe('photo-7'); // +2
      expect(queue[2]?.id).toBe('photo-4'); // -1 (last)
    });

    it('simulates navigation from photo 5 to 6: preloads 7, 8, 5', () => {
      const photos = createMockPhotos(10);
      // After navigating to index 6
      const queue = generatePreloadQueue(photos, 6, 'forward');

      const ids = queue.map((p) => p.id);
      expect(ids[0]).toBe('photo-7'); // +1 (priority)
      expect(ids[1]).toBe('photo-8'); // +2 (priority)
      expect(ids[2]).toBe('photo-5'); // -1 (fallback)
    });
  });

  describe('backward navigation (direction = "backward")', () => {
    it('prioritizes photos behind when navigating backward', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 5, 'backward');

      // Should preload: -1 (4), -2 (3), then +1 (6)
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-4'); // -1 (priority)
      expect(ids).toContain('photo-3'); // -2 (priority)
      expect(ids).toContain('photo-6'); // +1 (fallback)
      expect(queue).toHaveLength(3);
    });

    it('puts backward photos first in the queue', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 5, 'backward');

      // First two should be backward photos
      expect(queue[0]?.id).toBe('photo-4'); // -1
      expect(queue[1]?.id).toBe('photo-3'); // -2
      expect(queue[2]?.id).toBe('photo-6'); // +1 (last)
    });

    it('simulates navigation from photo 5 to 4: preloads 3, 2, 5', () => {
      const photos = createMockPhotos(10);
      // After navigating to index 4
      const queue = generatePreloadQueue(photos, 4, 'backward');

      const ids = queue.map((p) => p.id);
      expect(ids[0]).toBe('photo-3'); // -1 (priority)
      expect(ids[1]).toBe('photo-2'); // -2 (priority)
      expect(ids[2]).toBe('photo-5'); // +1 (fallback)
    });
  });

  describe('array boundary handling', () => {
    it('does not try to preload before index 0', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 0, 'initial');

      // Should only preload forward: +1, +2
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-1');
      expect(ids).toContain('photo-2');
      // Should NOT contain negative indices
      expect(ids).not.toContain('photo--1');
      expect(queue).toHaveLength(2);
    });

    it('does not try to preload beyond array length', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 9, 'initial');

      // Should only preload backward: -1, -2
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-8');
      expect(ids).toContain('photo-7');
      // Should NOT contain beyond array
      expect(ids).not.toContain('photo-10');
      expect(ids).not.toContain('photo-11');
      expect(queue).toHaveLength(2);
    });

    it('handles index 1 correctly (only one photo before)', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 1, 'initial');

      // +1 (2), -1 (0), +2 (3) - no -2
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-2'); // +1
      expect(ids).toContain('photo-0'); // -1
      expect(ids).toContain('photo-3'); // +2
      expect(ids).not.toContain('photo--1'); // no -2
      expect(queue).toHaveLength(3);
    });

    it('handles second-to-last index correctly', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 8, 'initial');

      // +1 (9), -1 (7), -2 (6) - no +2
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-9'); // +1
      expect(ids).toContain('photo-7'); // -1
      expect(ids).toContain('photo-6'); // -2
      expect(ids).not.toContain('photo-10'); // no +2
      expect(queue).toHaveLength(3);
    });

    it('handles forward navigation at end of array', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 9, 'forward');

      // At end, no +1 or +2, only -1
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-8');
      expect(queue).toHaveLength(1);
    });

    it('handles backward navigation at start of array', () => {
      const photos = createMockPhotos(10);
      const queue = generatePreloadQueue(photos, 0, 'backward');

      // At start, no -1 or -2, only +1
      const ids = queue.map((p) => p.id);
      expect(ids).toContain('photo-1');
      expect(queue).toHaveLength(1);
    });

    it('handles very small array (2 photos)', () => {
      const photos = createMockPhotos(2);
      const queue = generatePreloadQueue(photos, 0, 'initial');

      // Only +1 exists
      expect(queue).toHaveLength(1);
      expect(queue[0]?.id).toBe('photo-1');
    });

    it('handles single photo array', () => {
      const photos = createMockPhotos(1);
      const queue = generatePreloadQueue(photos, 0, 'initial');

      // No adjacent photos to preload
      expect(queue).toHaveLength(0);
    });
  });

  describe('skips photos without shardIds', () => {
    it('skips photos with empty shardIds array', () => {
      const photos = createMockPhotos(10);
      // Replace photo-6 and photo-4 with versions that have no shards
      photos[6] = createPhotoWithoutShards(6);
      photos[4] = createPhotoWithoutShards(4);

      const queue = generatePreloadQueue(photos, 5, 'initial');

      // Should only have photo-7 and photo-3
      const ids = queue.map((p) => p.id);
      expect(ids).not.toContain('photo-6');
      expect(ids).not.toContain('photo-4');
      expect(ids).toContain('photo-7');
      expect(ids).toContain('photo-3');
      expect(queue).toHaveLength(2);
    });

    it('skips photos with undefined shardIds', () => {
      const photos = createMockPhotos(10);
      // Remove shardIds entirely
      delete (photos[6] as Partial<PhotoMeta>).shardIds;

      const queue = generatePreloadQueue(photos, 5, 'initial');

      const ids = queue.map((p) => p.id);
      expect(ids).not.toContain('photo-6');
    });

    it('handles case where all adjacent photos lack shards', () => {
      const photos = createMockPhotos(10);
      // Remove shards from all adjacent photos
      photos[4] = createPhotoWithoutShards(4);
      photos[6] = createPhotoWithoutShards(6);
      photos[3] = createPhotoWithoutShards(3);
      photos[7] = createPhotoWithoutShards(7);

      const queue = generatePreloadQueue(photos, 5, 'initial');

      // Queue should be empty
      expect(queue).toHaveLength(0);
    });

    it('forward navigation skips photos without shards but still includes fallback', () => {
      const photos = createMockPhotos(10);
      // Remove shards from +1
      photos[6] = createPhotoWithoutShards(6);

      const queue = generatePreloadQueue(photos, 5, 'forward');

      // Should have +2 (7) and -1 (4), but not +1 (6)
      const ids = queue.map((p) => p.id);
      expect(ids).not.toContain('photo-6');
      expect(ids).toContain('photo-7'); // +2
      expect(ids).toContain('photo-4'); // -1 fallback
      expect(queue).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('handles empty photo array', () => {
      const photos: PhotoMeta[] = [];
      const queue = generatePreloadQueue(photos, 0, 'initial');

      expect(queue).toHaveLength(0);
    });

    it('handles out-of-bounds index gracefully', () => {
      const photos = createMockPhotos(5);
      // Index 10 is out of bounds for array of 5
      const queue = generatePreloadQueue(photos, 10, 'initial');

      // Should not crash, just return empty
      expect(queue).toHaveLength(0);
    });

    it('handles negative index gracefully', () => {
      const photos = createMockPhotos(5);
      const queue = generatePreloadQueue(photos, -1, 'initial');

      // Should not crash
      // May include photo-0 as +1 from -1, depending on implementation
      expect(Array.isArray(queue)).toBe(true);
    });
  });
});
