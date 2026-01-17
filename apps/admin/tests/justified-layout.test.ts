/**
 * Tests for Justified Layout Algorithm
 */

import { describe, expect, it } from 'vitest';
import {
  computeJustifiedLayout,
  findPhotoRow,
  getRowOffset,
  getTotalHeight,
  getVisibleRows,
} from '../src/lib/justified-layout';
import type { PhotoMeta } from '../src/workers/types';

// Helper to create a mock photo with specific dimensions
function createMockPhoto(id: string, width: number, height: number): PhotoMeta {
  return {
    id,
    albumId: 'album-1',
    filename: `photo-${id}.jpg`,
    mimeType: 'image/jpeg',
    shardIds: ['shard-1'],
    epochId: 1,
    width,
    height,
    createdAt: new Date().toISOString(),
  };
}

describe('computeJustifiedLayout', () => {
  it('should return empty array for empty photos', () => {
    const rows = computeJustifiedLayout([], { containerWidth: 1000 });
    expect(rows).toEqual([]);
  });

  it('should return empty array for zero container width', () => {
    const photos = [createMockPhoto('1', 100, 100)];
    const rows = computeJustifiedLayout(photos, { containerWidth: 0 });
    expect(rows).toEqual([]);
  });

  it('should create single row for few photos', () => {
    const photos = [
      createMockPhoto('1', 400, 300), // 4:3 aspect ratio
      createMockPhoto('2', 300, 300), // 1:1 aspect ratio
    ];
    const rows = computeJustifiedLayout(photos, {
      containerWidth: 1000,
      targetRowHeight: 200,
    });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    // First row should contain both photos if they fit
    expect(rows[0]!.photos.length).toBeGreaterThanOrEqual(1);
  });

  it('should fill row width for full rows', () => {
    const photos = Array.from({ length: 10 }, (_, i) =>
      createMockPhoto(String(i + 1), 400, 300),
    );
    const containerWidth = 800;
    const gap = 4;
    const rows = computeJustifiedLayout(photos, {
      containerWidth,
      targetRowHeight: 200,
      gap,
    });

    // Full rows should approximately fill the container width
    if (rows.length > 1) {
      const firstRow = rows[0]!;
      const totalRowWidth =
        firstRow.photos.reduce((sum, p) => sum + p.width, 0) +
        (firstRow.photos.length - 1) * gap;
      // Allow small tolerance for rounding
      expect(Math.abs(totalRowWidth - containerWidth)).toBeLessThanOrEqual(2);
    }
  });

  it('should handle landscape photos', () => {
    const photos = [
      createMockPhoto('1', 1920, 1080), // 16:9 landscape
    ];
    const rows = computeJustifiedLayout(photos, {
      containerWidth: 1000,
      targetRowHeight: 200,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.photos[0]!.width).toBeGreaterThan(
      rows[0]!.photos[0]!.height,
    );
  });

  it('should handle portrait photos', () => {
    const photos = [
      createMockPhoto('1', 1080, 1920), // 9:16 portrait
    ];
    const rows = computeJustifiedLayout(photos, {
      containerWidth: 1000,
      targetRowHeight: 200,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.photos[0]!.width).toBeLessThan(rows[0]!.photos[0]!.height);
  });

  it('should use default aspect ratio for photos without dimensions', () => {
    const photo: PhotoMeta = {
      id: '1',
      albumId: 'album-1',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      shardIds: ['shard-1'],
      epochId: 1,
      // No width/height
      createdAt: new Date().toISOString(),
    };
    const rows = computeJustifiedLayout([photo], {
      containerWidth: 1000,
      targetRowHeight: 200,
    });

    expect(rows.length).toBe(1);
    // Default aspect ratio is 4:3
    const aspectRatio = rows[0]!.photos[0]!.width / rows[0]!.photos[0]!.height;
    expect(aspectRatio).toBeCloseTo(4 / 3, 1);
  });

  it('should preserve photo ordering', () => {
    const photos = [
      createMockPhoto('a', 400, 300),
      createMockPhoto('b', 300, 400),
      createMockPhoto('c', 500, 300),
    ];
    const rows = computeJustifiedLayout(photos, {
      containerWidth: 1000,
      targetRowHeight: 200,
    });

    // Flatten all photos from rows and check order
    const allPhotoIds = rows.flatMap((row) =>
      row.photos.map((p) => p.photo.id),
    );
    expect(allPhotoIds).toEqual(['a', 'b', 'c']);
  });
});

describe('getTotalHeight', () => {
  it('should return 0 for empty rows', () => {
    expect(getTotalHeight([])).toBe(0);
  });

  it('should calculate total height with gaps', () => {
    const rows = [
      { photos: [], height: 200 },
      { photos: [], height: 250 },
      { photos: [], height: 180 },
    ];
    const gap = 4;
    const expected = 200 + 250 + 180 + 2 * gap; // 3 rows, 2 gaps
    expect(getTotalHeight(rows, gap)).toBe(expected);
  });

  it('should handle single row', () => {
    const rows = [{ photos: [], height: 200 }];
    expect(getTotalHeight(rows, 4)).toBe(200);
  });
});

describe('findPhotoRow', () => {
  const mockPhoto1 = createMockPhoto('photo-1', 400, 300);
  const mockPhoto2 = createMockPhoto('photo-2', 300, 400);
  const mockPhoto3 = createMockPhoto('photo-3', 500, 300);

  const rows = [
    {
      photos: [
        { photo: mockPhoto1, width: 200, height: 150 },
        { photo: mockPhoto2, width: 150, height: 150 },
      ],
      height: 150,
    },
    {
      photos: [{ photo: mockPhoto3, width: 300, height: 180 }],
      height: 180,
    },
  ];

  it('should find photo in first row', () => {
    const result = findPhotoRow(rows, 'photo-1');
    expect(result).toEqual({ rowIndex: 0, photoIndex: 0 });
  });

  it('should find photo in second position of first row', () => {
    const result = findPhotoRow(rows, 'photo-2');
    expect(result).toEqual({ rowIndex: 0, photoIndex: 1 });
  });

  it('should find photo in second row', () => {
    const result = findPhotoRow(rows, 'photo-3');
    expect(result).toEqual({ rowIndex: 1, photoIndex: 0 });
  });

  it('should return null for non-existent photo', () => {
    const result = findPhotoRow(rows, 'non-existent');
    expect(result).toBeNull();
  });

  it('should return null for empty rows', () => {
    const result = findPhotoRow([], 'photo-1');
    expect(result).toBeNull();
  });
});

describe('getRowOffset', () => {
  const rows = [
    { photos: [], height: 200 },
    { photos: [], height: 250 },
    { photos: [], height: 180 },
  ];

  it('should return 0 for first row', () => {
    expect(getRowOffset(rows, 0, 4)).toBe(0);
  });

  it('should return correct offset for second row', () => {
    expect(getRowOffset(rows, 1, 4)).toBe(200 + 4); // height of row 0 + gap
  });

  it('should return correct offset for third row', () => {
    expect(getRowOffset(rows, 2, 4)).toBe(200 + 4 + 250 + 4); // rows 0-1 + gaps
  });

  it('should handle out of bounds index', () => {
    // Should calculate offset as if row exists
    expect(getRowOffset(rows, 5, 4)).toBe(200 + 4 + 250 + 4 + 180 + 4);
  });
});

describe('getVisibleRows', () => {
  const rows = [
    { photos: [], height: 200 },
    { photos: [], height: 200 },
    { photos: [], height: 200 },
    { photos: [], height: 200 },
    { photos: [], height: 200 },
  ];

  it('should return first rows when scrolled to top', () => {
    const result = getVisibleRows(rows, 0, 400, 4, 1);
    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBeLessThanOrEqual(4); // viewport + overscan
  });

  it('should return middle rows when scrolled', () => {
    const result = getVisibleRows(rows, 400, 400, 4, 0);
    expect(result.startIndex).toBeGreaterThan(0);
  });

  it('should include overscan rows', () => {
    const result = getVisibleRows(rows, 200, 200, 4, 2);
    // With overscan of 2, should include extra rows before and after
    expect(result.startIndex).toBeLessThanOrEqual(1);
  });

  it('should handle empty rows', () => {
    const result = getVisibleRows([], 0, 400, 4, 1);
    expect(result).toEqual({ startIndex: 0, endIndex: 0, offsetY: 0 });
  });
});
