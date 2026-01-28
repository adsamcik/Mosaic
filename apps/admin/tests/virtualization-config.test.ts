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
  const virtualizerMatch = fileContent.match(
    /useVirtualizer\s*\(\s*\{[^}]*overscan\s*:\s*(\d+)/s,
  );
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
  const hasMemoImport =
    /import\s*\{[^}]*\bmemo\b[^}]*\}\s*from\s*['"]react['"]/.test(fileContent);
  // Check for memo() usage in export
  const hasMemoExport = /export\s+(const|function)\s+\w+\s*=\s*memo\s*\(/.test(
    fileContent,
  );
  return hasMemoImport && hasMemoExport;
}

describe('Virtualization Configuration', () => {
  const componentsDir = path.resolve(__dirname, '../src/components');

  describe('overscan values', () => {
    const mosaicGridFiles = [
      { name: 'MosaicPhotoGrid', path: 'Gallery/MosaicPhotoGrid.tsx' },
      {
        name: 'EnhancedMosaicPhotoGrid',
        path: 'Gallery/EnhancedMosaicPhotoGrid.tsx',
      },
      {
        name: 'SharedMosaicPhotoGrid',
        path: 'Shared/SharedMosaicPhotoGrid.tsx',
      },
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
  it('should ensure overscan values are consistent across grid components', () => {
    // This test verifies that overscan values are consistent
    // to avoid rendering behavior inconsistencies between components
    const mosaicGridFiles = [
      { name: 'MosaicPhotoGrid', path: 'Gallery/MosaicPhotoGrid.tsx' },
      {
        name: 'EnhancedMosaicPhotoGrid',
        path: 'Gallery/EnhancedMosaicPhotoGrid.tsx',
      },
      {
        name: 'SharedMosaicPhotoGrid',
        path: 'Shared/SharedMosaicPhotoGrid.tsx',
      },
    ];

    const componentsDir = path.resolve(__dirname, '../src/components');
    const overscanValues: number[] = [];

    for (const { path: filePath } of mosaicGridFiles) {
      const fullPath = path.join(componentsDir, filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const overscan = extractOverscanValue(content);
      if (overscan !== null) {
        overscanValues.push(overscan);
      }
    }

    // All files should have the same overscan value for consistency
    expect(overscanValues.length).toBeGreaterThan(0);
    const uniqueValues = new Set(overscanValues);
    expect(uniqueValues.size).toBe(1);
  });

  it('should verify all thumbnail components use React.memo', () => {
    // Verify React.memo is consistently applied to prevent unnecessary re-renders
    // during scroll, selection, and other frequent parent updates
    const componentsDir = path.resolve(__dirname, '../src/components');
    const thumbnailComponents = [
      { name: 'PhotoThumbnail', path: 'Gallery/PhotoThumbnail.tsx' },
      { name: 'MosaicTile', path: 'Gallery/MosaicTile.tsx' },
      { name: 'SharedPhotoThumbnail', path: 'Shared/SharedPhotoThumbnail.tsx' },
    ];

    const memoUsage: boolean[] = [];

    for (const { path: filePath } of thumbnailComponents) {
      const fullPath = path.join(componentsDir, filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      memoUsage.push(usesReactMemo(content));
    }

    // All thumbnail components should use React.memo
    expect(memoUsage.every((uses) => uses)).toBe(true);
    expect(memoUsage.length).toBe(thumbnailComponents.length);
  });
});
