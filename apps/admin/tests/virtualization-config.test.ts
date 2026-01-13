/**
 * Virtualization Configuration Tests
 * 
 * These tests verify that the virtualization is correctly configured
 * to prevent performance issues from excessive DOM rendering.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Extracts overscan value from TanStack Virtual useVirtualizer call
 */
function extractOverscanValue(fileContent: string): number | null {
  // Match useVirtualizer({ ... overscan: <number> ... })
  const virtualizerMatch = fileContent.match(/useVirtualizer\s*\(\s*\{[^}]*overscan\s*:\s*(\d+)/s);
  if (virtualizerMatch) {
    return parseInt(virtualizerMatch[1], 10);
  }
  return null;
}

/**
 * Checks if a component file uses React.memo
 */
function usesReactMemo(fileContent: string): boolean {
  // Check for memo import
  const hasMemoImport = /import\s*\{[^}]*\bmemo\b[^}]*\}\s*from\s*['"]react['"]/.test(fileContent);
  // Check for memo() usage in export
  const hasMemoExport = /export\s+(const|function)\s+\w+\s*=\s*memo\s*\(/.test(fileContent);
  return hasMemoImport && hasMemoExport;
}

describe('Virtualization Configuration', () => {
  const componentsDir = path.resolve(__dirname, '../src/components');

  describe('overscan values', () => {
    const mosaicGridFiles = [
      { name: 'MosaicPhotoGrid', path: 'Gallery/MosaicPhotoGrid.tsx' },
      { name: 'EnhancedMosaicPhotoGrid', path: 'Gallery/EnhancedMosaicPhotoGrid.tsx' },
      { name: 'SharedMosaicPhotoGrid', path: 'Shared/SharedMosaicPhotoGrid.tsx' },
    ];

    for (const { name, path: filePath } of mosaicGridFiles) {
      it(`${name} should have reasonable overscan value (≤ 5 rows)`, () => {
        const fullPath = path.join(componentsDir, filePath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const overscan = extractOverscanValue(content);

        expect(overscan).not.toBeNull();
        expect(overscan).toBeGreaterThan(0);
        // Overscan should be ≤ 5 rows, not 500 (which was a bug)
        expect(overscan).toBeLessThanOrEqual(5);
      });
    }
  });

  describe('React.memo optimization', () => {
    const thumbnailComponents = [
      { name: 'PhotoThumbnail', path: 'Gallery/PhotoThumbnail.tsx' },
      { name: 'MosaicTile', path: 'Gallery/MosaicTile.tsx' },
      { name: 'SharedPhotoThumbnail', path: 'Shared/SharedPhotoThumbnail.tsx' },
    ];

    for (const { name, path: filePath } of thumbnailComponents) {
      it(`${name} should be wrapped with React.memo`, () => {
        const fullPath = path.join(componentsDir, filePath);
        const content = fs.readFileSync(fullPath, 'utf-8');

        expect(usesReactMemo(content)).toBe(true);
      });
    }
  });
});

describe('Performance constraints documentation', () => {
  it('should document the overscan configuration rationale', () => {
    // This test documents WHY the overscan value matters:
    // - TanStack Virtual interprets 'overscan' as number of ITEMS (rows)
    // - A value of 500 would render ~500 extra rows above/below viewport
    // - For a typical album with 3-5 photos per row, this means ~1500-2500 extra DOM elements
    // - Correct value of 3-5 rows provides smooth scrolling without excessive rendering
    expect(true).toBe(true);
  });

  it('should document React.memo benefits for thumbnails', () => {
    // This test documents WHY React.memo matters for thumbnails:
    // - Parent grid components re-render on scroll, selection changes, etc.
    // - Without memo, every visible thumbnail re-renders on each parent render
    // - With memo, thumbnails only re-render when their specific props change
    // - This is critical for smooth scrolling in large galleries
    expect(true).toBe(true);
  });
});
