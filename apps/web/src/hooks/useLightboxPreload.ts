/**
 * useLightboxPreload Hook
 *
 * Computes a direction-aware preload queue for the photo lightbox.
 * When navigating forward, prioritizes photos ahead of the current index.
 * When navigating backward, prioritizes photos behind.
 * On initial open, preloads equally in both directions.
 */

import { useMemo } from 'react';
import type { NavigationDirection } from './useLightbox';
import type { PhotoMeta } from '../workers/types';

/** Default number of photos to preload ahead/behind in lightbox */
const DEFAULT_PRELOAD_COUNT = 2;

export interface UseLightboxPreloadOptions {
  /** Whether the lightbox is currently open */
  isOpen: boolean;
  /** Index of the currently displayed photo */
  currentIndex: number;
  /** Direction of the last navigation action */
  navigationDirection: NavigationDirection;
  /** Full photo array to index into */
  photos: PhotoMeta[];
  /** Number of photos to preload in the priority direction (default: 2) */
  preloadCount?: number;
}

/**
 * Computes a direction-aware preload queue for the photo lightbox.
 *
 * - **forward**: preloads N+1 … N+count ahead, then one behind
 * - **backward**: preloads N-1 … N-count behind, then one ahead
 * - **initial**: preloads equally in both directions
 *
 * @returns Array of PhotoMeta to pass as `preloadQueue` to the lightbox component
 */
export function useLightboxPreload({
  isOpen,
  currentIndex,
  navigationDirection,
  photos,
  preloadCount = DEFAULT_PRELOAD_COUNT,
}: UseLightboxPreloadOptions): PhotoMeta[] {
  return useMemo((): PhotoMeta[] => {
    if (!isOpen) return [];

    const queue: PhotoMeta[] = [];

    if (navigationDirection === 'forward') {
      for (let offset = 1; offset <= preloadCount; offset++) {
        const next = photos[currentIndex + offset];
        if (next) queue.push(next);
      }
      const prev = photos[currentIndex - 1];
      if (prev) queue.push(prev);
    } else if (navigationDirection === 'backward') {
      for (let offset = 1; offset <= preloadCount; offset++) {
        const prev = photos[currentIndex - offset];
        if (prev) queue.push(prev);
      }
      const next = photos[currentIndex + 1];
      if (next) queue.push(next);
    } else {
      // Initial open: preload equally in both directions
      for (let offset = 1; offset <= preloadCount; offset++) {
        const next = photos[currentIndex + offset];
        const prev = photos[currentIndex - offset];
        if (next) queue.push(next);
        if (prev) queue.push(prev);
      }
    }

    return queue;
  }, [isOpen, currentIndex, navigationDirection, photos, preloadCount]);
}
