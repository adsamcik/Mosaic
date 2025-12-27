/**
 * useLightbox Hook Tests
 *
 * Tests for the lightbox state management hook.
 * Tests the underlying logic rather than React hook behavior
 * since @testing-library/react is not available.
 */

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLightbox } from '../src/hooks/useLightbox';
import type { PhotoMeta } from '../src/workers/types';

// Create mock photos for testing
function createMockPhoto(id: string, index: number): PhotoMeta {
  return {
    id,
    assetId: `asset-${id}`,
    albumId: 'album-1',
    filename: `photo-${index}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    shardIds: [`shard-${id}-1`, `shard-${id}-2`],
    epochId: 1,
    createdAt: '2024-01-01T12:00:00Z',
    updatedAt: '2024-01-01T12:00:00Z',
  };
}

// Helper to test hook in a component context
function createHookTester(photos: PhotoMeta[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  // Store hook result for assertions
  let hookResult: ReturnType<typeof useLightbox> | null = null;
  let setPhotos: ((photos: PhotoMeta[]) => void) | null = null;

  function TestComponent({ initialPhotos }: { initialPhotos: PhotoMeta[] }) {
    const [photosState, setPhotosState] = useState(initialPhotos);
    setPhotos = setPhotosState;
    hookResult = useLightbox(photosState);
    return null;
  }

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(TestComponent, { initialPhotos: photos }));
  });

  const getResult = () => hookResult!;

  const updatePhotos = (newPhotos: PhotoMeta[]) => {
    act(() => {
      setPhotos!(newPhotos);
    });
  };

  const cleanup = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  return { getResult, updatePhotos, cleanup };
}

describe('useLightbox', () => {
  const mockPhotos = [
    createMockPhoto('photo-1', 0),
    createMockPhoto('photo-2', 1),
    createMockPhoto('photo-3', 2),
    createMockPhoto('photo-4', 3),
    createMockPhoto('photo-5', 4),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('starts with lightbox closed', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);
      const result = getResult();

      expect(result.isOpen).toBe(false);
      expect(result.currentPhoto).toBe(null);
      expect(result.currentIndex).toBe(0);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrevious).toBe(false);
      cleanup();
    });

    it('handles empty photos array', () => {
      const { getResult, cleanup } = createHookTester([]);
      const result = getResult();

      expect(result.isOpen).toBe(false);
      expect(result.currentPhoto).toBe(null);
      cleanup();
    });
  });

  describe('open', () => {
    it('opens lightbox at specified index', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      const result = getResult();
      expect(result.isOpen).toBe(true);
      expect(result.currentIndex).toBe(2);
      expect(result.currentPhoto).toBe(mockPhotos[2]);
      cleanup();
    });

    it('sets hasNext and hasPrevious correctly when in middle', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      const result = getResult();
      expect(result.hasNext).toBe(true);
      expect(result.hasPrevious).toBe(true);
      cleanup();
    });

    it('sets hasNext false when at last photo', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(4);
      });

      const result = getResult();
      expect(result.hasNext).toBe(false);
      expect(result.hasPrevious).toBe(true);
      cleanup();
    });

    it('sets hasPrevious false when at first photo', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(0);
      });

      const result = getResult();
      expect(result.hasNext).toBe(true);
      expect(result.hasPrevious).toBe(false);
      cleanup();
    });

    it('ignores open with invalid index (negative)', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(-1);
      });

      expect(getResult().isOpen).toBe(false);
      cleanup();
    });

    it('ignores open with invalid index (too high)', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(10);
      });

      expect(getResult().isOpen).toBe(false);
      cleanup();
    });
  });

  describe('close', () => {
    it('closes lightbox', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      expect(getResult().isOpen).toBe(true);

      act(() => {
        getResult().close();
      });

      expect(getResult().isOpen).toBe(false);
      expect(getResult().currentPhoto).toBe(null);
      cleanup();
    });
  });

  describe('next', () => {
    it('navigates to next photo', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(1);
      });

      act(() => {
        getResult().next();
      });

      const result = getResult();
      expect(result.currentIndex).toBe(2);
      expect(result.currentPhoto).toBe(mockPhotos[2]);
      cleanup();
    });

    it('does not go past last photo', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(4);
      });

      act(() => {
        getResult().next();
      });

      expect(getResult().currentIndex).toBe(4);
      cleanup();
    });
  });

  describe('previous', () => {
    it('navigates to previous photo', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      act(() => {
        getResult().previous();
      });

      const result = getResult();
      expect(result.currentIndex).toBe(1);
      expect(result.currentPhoto).toBe(mockPhotos[1]);
      cleanup();
    });

    it('does not go before first photo', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(0);
      });

      act(() => {
        getResult().previous();
      });

      expect(getResult().currentIndex).toBe(0);
      cleanup();
    });
  });

  describe('goTo', () => {
    it('navigates to specific index', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(0);
      });

      act(() => {
        getResult().goTo(3);
      });

      const result = getResult();
      expect(result.currentIndex).toBe(3);
      expect(result.currentPhoto).toBe(mockPhotos[3]);
      cleanup();
    });

    it('ignores invalid index', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      act(() => {
        getResult().goTo(100);
      });

      expect(getResult().currentIndex).toBe(2);
      cleanup();
    });
  });

  describe('keyboard navigation', () => {
    it('closes on Escape key', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      expect(getResult().isOpen).toBe(true);

      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'Escape' });
        document.dispatchEvent(event);
      });

      expect(getResult().isOpen).toBe(false);
      cleanup();
    });

    it('navigates next on ArrowRight key', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(1);
      });

      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
        document.dispatchEvent(event);
      });

      expect(getResult().currentIndex).toBe(2);
      cleanup();
    });

    it('navigates previous on ArrowLeft key', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
        document.dispatchEvent(event);
      });

      expect(getResult().currentIndex).toBe(1);
      cleanup();
    });

    it('does not respond to keyboard when closed', () => {
      const { getResult, cleanup } = createHookTester(mockPhotos);

      // Don't open the lightbox
      const initialIndex = getResult().currentIndex;

      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
        document.dispatchEvent(event);
      });

      expect(getResult().currentIndex).toBe(initialIndex);
      expect(getResult().isOpen).toBe(false);
      cleanup();
    });
  });

  describe('photos array changes', () => {
    it('closes lightbox when photos become empty', () => {
      const { getResult, updatePhotos, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(2);
      });

      expect(getResult().isOpen).toBe(true);

      updatePhotos([]);

      expect(getResult().isOpen).toBe(false);
      cleanup();
    });

    it('adjusts currentIndex when photos array shrinks', () => {
      const { getResult, updatePhotos, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(4);
      });

      expect(getResult().currentIndex).toBe(4);

      // Shrink the array
      updatePhotos(mockPhotos.slice(0, 2));

      // Index should adjust to the new last valid index
      expect(getResult().currentIndex).toBe(1);
      cleanup();
    });
  });

  describe('body scroll lock', () => {
    it('locks body scroll when open', () => {
      const originalOverflow = document.body.style.overflow;

      const { getResult, cleanup } = createHookTester(mockPhotos);

      act(() => {
        getResult().open(0);
      });

      expect(document.body.style.overflow).toBe('hidden');

      act(() => {
        getResult().close();
      });

      expect(document.body.style.overflow).toBe(originalOverflow);
      cleanup();
    });
  });
});
