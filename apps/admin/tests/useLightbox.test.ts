/**
 * useLightbox Hook Tests
 *
 * Tests the lightbox state management including navigation direction tracking
 * for viewport-based preloading.
 */

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLightbox, type UseLightboxResult } from '../src/hooks/useLightbox';
import type { PhotoMeta } from '../src/workers/types';

// Create mock photos for testing
function createMockPhotos(count: number): PhotoMeta[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: `photo-${i}`,
    assetId: `asset-${i}`,
    albumId: 'album-1',
    filename: `photo-${i}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    shardIds: [`shard-${i}`],
    thumbnail: '',
    createdAt: now,
    updatedAt: now,
    description: '',
    tags: [],
    epochId: 1,
  }));
}

// Test harness component that exposes hook results
interface HarnessProps {
  photos: PhotoMeta[];
  onResult: (result: UseLightboxResult) => void;
}

function TestHarness({ photos, onResult }: HarnessProps) {
  const result = useLightbox(photos);
  onResult(result);
  return null;
}

describe('useLightbox', () => {
  let container: HTMLElement;
  let root: Root;
  let hookResult: UseLightboxResult;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookResult = undefined as unknown as UseLightboxResult;
  });

  afterEach(() => {
    root.unmount();
    document.body.removeChild(container);
  });

  function renderHook(photos: PhotoMeta[]) {
    act(() => {
      root.render(
        createElement(TestHarness, {
          photos,
          onResult: (result) => {
            hookResult = result;
          },
        }),
      );
    });
    return hookResult;
  }

  describe('basic navigation', () => {
    it('should start closed', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      expect(hookResult.isOpen).toBe(false);
      expect(hookResult.currentPhoto).toBeNull();
    });

    it('should open at specific index', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });

      expect(hookResult.isOpen).toBe(true);
      expect(hookResult.currentIndex).toBe(2);
      expect(hookResult.currentPhoto?.id).toBe('photo-2');
    });

    it('should navigate next', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });

      act(() => {
        hookResult.next();
      });

      expect(hookResult.currentIndex).toBe(3);
      expect(hookResult.currentPhoto?.id).toBe('photo-3');
    });

    it('should navigate previous', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });

      act(() => {
        hookResult.previous();
      });

      expect(hookResult.currentIndex).toBe(1);
      expect(hookResult.currentPhoto?.id).toBe('photo-1');
    });

    it('should not navigate beyond bounds', () => {
      const photos = createMockPhotos(3);
      renderHook(photos);

      // Test can't go past end
      act(() => {
        hookResult.open(2);
      });
      act(() => {
        hookResult.next();
      });
      expect(hookResult.currentIndex).toBe(2);

      // Test can't go past start
      act(() => {
        hookResult.open(0);
      });
      act(() => {
        hookResult.previous();
      });
      expect(hookResult.currentIndex).toBe(0);
    });

    it('should close lightbox', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });
      expect(hookResult.isOpen).toBe(true);

      act(() => {
        hookResult.close();
      });
      expect(hookResult.isOpen).toBe(false);
      expect(hookResult.currentPhoto).toBeNull();
    });
  });

  describe('navigation direction tracking', () => {
    it('should set initial direction when opening', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });

      expect(hookResult.navigationDirection).toBe('initial');
    });

    it('should track forward direction when navigating next', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(1);
      });
      expect(hookResult.navigationDirection).toBe('initial');

      act(() => {
        hookResult.next();
      });
      expect(hookResult.navigationDirection).toBe('forward');
      expect(hookResult.currentIndex).toBe(2);
    });

    it('should track backward direction when navigating previous', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(3);
      });
      expect(hookResult.navigationDirection).toBe('initial');

      act(() => {
        hookResult.previous();
      });
      expect(hookResult.navigationDirection).toBe('backward');
      expect(hookResult.currentIndex).toBe(2);
    });

    it('should maintain forward direction on consecutive next calls', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(0);
      });

      act(() => {
        hookResult.next();
      });
      expect(hookResult.navigationDirection).toBe('forward');

      act(() => {
        hookResult.next();
      });
      expect(hookResult.navigationDirection).toBe('forward');
      expect(hookResult.currentIndex).toBe(2);
    });

    it('should change direction when reversing', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });

      // Navigate forward
      act(() => {
        hookResult.next();
      });
      expect(hookResult.navigationDirection).toBe('forward');
      expect(hookResult.currentIndex).toBe(3);

      // Now reverse direction
      act(() => {
        hookResult.previous();
      });
      expect(hookResult.navigationDirection).toBe('backward');
      expect(hookResult.currentIndex).toBe(2);
    });

    it('should reset direction when closing and reopening', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(1);
      });

      act(() => {
        hookResult.next();
      });
      expect(hookResult.navigationDirection).toBe('forward');

      act(() => {
        hookResult.close();
      });

      act(() => {
        hookResult.open(3);
      });
      expect(hookResult.navigationDirection).toBe('initial');
    });

    it('should not change direction when hitting boundary', () => {
      const photos = createMockPhotos(3);
      renderHook(photos);

      // Start at end, navigate forward
      act(() => {
        hookResult.open(2);
      });

      act(() => {
        hookResult.next();
      });
      // Should stay at 2, direction unchanged from initial
      expect(hookResult.currentIndex).toBe(2);
      expect(hookResult.navigationDirection).toBe('initial');

      // Navigate backward first to set direction
      act(() => {
        hookResult.previous();
      });
      expect(hookResult.navigationDirection).toBe('backward');

      // Go to start
      act(() => {
        hookResult.previous();
      });
      expect(hookResult.currentIndex).toBe(0);
      expect(hookResult.navigationDirection).toBe('backward');

      // Try to go past start - should maintain backward direction
      act(() => {
        hookResult.previous();
      });
      expect(hookResult.currentIndex).toBe(0);
      expect(hookResult.navigationDirection).toBe('backward');
    });
  });

  describe('hasNext and hasPrevious', () => {
    it('should correctly report navigation availability', () => {
      const photos = createMockPhotos(3);
      renderHook(photos);

      // At start
      act(() => {
        hookResult.open(0);
      });
      expect(hookResult.hasPrevious).toBe(false);
      expect(hookResult.hasNext).toBe(true);

      // In middle
      act(() => {
        hookResult.open(1);
      });
      expect(hookResult.hasPrevious).toBe(true);
      expect(hookResult.hasNext).toBe(true);

      // At end
      act(() => {
        hookResult.open(2);
      });
      expect(hookResult.hasPrevious).toBe(true);
      expect(hookResult.hasNext).toBe(false);
    });

    it('should report false when closed', () => {
      const photos = createMockPhotos(3);
      renderHook(photos);

      expect(hookResult.hasPrevious).toBe(false);
      expect(hookResult.hasNext).toBe(false);
    });
  });

  describe('goTo navigation', () => {
    it('should navigate to specific index', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(0);
      });

      act(() => {
        hookResult.goTo(4);
      });

      expect(hookResult.currentIndex).toBe(4);
      expect(hookResult.currentPhoto?.id).toBe('photo-4');
    });

    it('should ignore invalid indices', () => {
      const photos = createMockPhotos(5);
      renderHook(photos);

      act(() => {
        hookResult.open(2);
      });

      act(() => {
        hookResult.goTo(-1);
      });
      expect(hookResult.currentIndex).toBe(2);

      act(() => {
        hookResult.goTo(10);
      });
      expect(hookResult.currentIndex).toBe(2);
    });
  });

  describe('empty photos array', () => {
    it('should handle empty photos array', () => {
      const photos: PhotoMeta[] = [];
      renderHook(photos);

      expect(hookResult.isOpen).toBe(false);
      expect(hookResult.currentPhoto).toBeNull();

      // Attempting to open should do nothing
      act(() => {
        hookResult.open(0);
      });
      expect(hookResult.isOpen).toBe(false);
    });
  });
});
