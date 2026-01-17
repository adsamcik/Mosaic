/**
 * useAnimatedItems Hook
 *
 * Tracks item enter/exit state for animations in virtualized lists.
 * Maintains "phantom" entries for items being removed so they can animate out.
 *
 * Key Features:
 * - Tracks which items are "new" (just appeared) vs "existing"
 * - Maintains exiting items in the list until animation completes
 * - Calculates stagger delays for batch operations
 * - Prevents re-animation when items re-enter viewport
 *
 * @module useAnimatedItems
 */

import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Represents an item with its animation state
 */
export interface AnimatedItem<T> {
  /** The original item */
  item: T;
  /** Unique stable key for this item */
  key: string;
  /** Timestamp when this item first appeared */
  appearedAt: number;
  /** Whether this item is animating out (being removed) */
  isExiting: boolean;
}

/**
 * Options for the useAnimatedItems hook
 */
export interface UseAnimatedItemsOptions<T> {
  /** Function to extract unique key from item */
  getKey: (item: T) => string;
  /** Callback when exit animation completes for an item */
  onRemoveComplete?: (key: string) => void;
  /** Time window (ms) to consider items as part of same batch. Default: 100 */
  batchWindow?: number;
  /** Delay (ms) between staggered items. Default: 50 */
  staggerInterval?: number;
  /** Maximum number of items to stagger (cap for performance). Default: 20 */
  maxStaggerCount?: number;
}

/**
 * Return type of useAnimatedItems hook
 */
export interface UseAnimatedItemsReturn<T> {
  /** Items with animation state attached */
  animatedItems: AnimatedItem<T>[];
  /** Callback to invoke when an item finishes exiting */
  handleExitComplete: (key: string) => void;
  /** Get the stagger delay for a specific item */
  getStaggerDelay: (key: string) => number;
  /** Check if an item has been seen before (to skip re-animation) */
  hasBeenSeen: (key: string) => boolean;
  /** Mark all current items as "seen" (call after initial load) */
  markAllAsSeen: () => void;
  /** Check if initial load has completed */
  isInitialLoad: boolean;
}

/**
 * Hook to track animation state for items in a list.
 *
 * Handles:
 * - New item detection (fade in)
 * - Removed item tracking (fade out with phantom entries)
 * - Batch staggering (cascading reveal)
 * - Viewport re-entry (no re-animation)
 *
 * @example
 * ```tsx
 * const { animatedItems, handleExitComplete, getStaggerDelay } = useAnimatedItems(
 *   photos,
 *   { getKey: (p) => p.id }
 * );
 *
 * return animatedItems.map(({ item, key, isExiting }) => (
 *   <AnimatedTile
 *     key={key}
 *     itemKey={key}
 *     isExiting={isExiting}
 *     staggerDelay={getStaggerDelay(key)}
 *     onExitComplete={() => handleExitComplete(key)}
 *   >
 *     <PhotoThumbnail photo={item} />
 *   </AnimatedTile>
 * ));
 * ```
 */
export function useAnimatedItems<T>(
  items: T[],
  options: UseAnimatedItemsOptions<T>,
): UseAnimatedItemsReturn<T> {
  const {
    getKey,
    onRemoveComplete,
    batchWindow = 100,
    staggerInterval = 50,
    maxStaggerCount = 20,
  } = options;

  // Track when items first appeared (survives re-renders)
  const seenKeys = useRef(new Map<string, number>());

  // Track items that have been "seen" in viewport (no re-animation)
  const viewedKeys = useRef(new Set<string>());

  // Track whether this is the initial load
  const isFirstRender = useRef(true);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Track items that are exiting (still visible but being removed)
  const [exitingItems, setExitingItems] = useState(new Map<string, T>());

  // Previous items for comparison
  const prevItemsRef = useRef<T[]>([]);
  const prevKeysRef = useRef(new Set<string>());

  // Compute animated items with enter/exit state
  const animatedItems = useMemo(() => {
    const now = Date.now();
    const currentKeys = new Set(items.map(getKey));
    const result: AnimatedItem<T>[] = [];

    // On first render, mark everything as "seen" to skip enter animations
    if (isFirstRender.current) {
      isFirstRender.current = false;
      for (const item of items) {
        const key = getKey(item);
        seenKeys.current.set(key, now);
        viewedKeys.current.add(key);
      }
      // Schedule marking initial load complete (after first paint)
      setTimeout(() => setIsInitialLoad(false), 50);
    }

    // Detect removed items (were in prev, not in current)
    const removedItems = new Map<string, T>();
    for (const item of prevItemsRef.current) {
      const key = getKey(item);
      if (!currentKeys.has(key)) {
        removedItems.set(key, item);
      }
    }

    // Add removed items to exiting set (if not already there)
    if (removedItems.size > 0) {
      setExitingItems((prev) => {
        const next = new Map(prev);
        for (const [key, item] of removedItems) {
          if (!next.has(key)) {
            next.set(key, item);
          }
        }
        return next;
      });
    }

    // Add current items
    for (const item of items) {
      const key = getKey(item);

      // Track first appearance
      if (!seenKeys.current.has(key)) {
        seenKeys.current.set(key, now);
      }

      result.push({
        item,
        key,
        appearedAt: seenKeys.current.get(key)!,
        isExiting: false,
      });
    }

    // Add phantom entries for exiting items (still animating out)
    for (const [key, item] of exitingItems) {
      // Only add if not already in current items
      if (!currentKeys.has(key)) {
        result.push({
          item,
          key,
          appearedAt: seenKeys.current.get(key) ?? now,
          isExiting: true,
        });
      }
    }

    // Update refs for next comparison
    prevItemsRef.current = items;
    prevKeysRef.current = currentKeys;

    return result;
  }, [items, getKey, exitingItems]);

  // Callback when exit animation completes
  const handleExitComplete = useCallback(
    (key: string) => {
      setExitingItems((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      seenKeys.current.delete(key);
      viewedKeys.current.delete(key);
      onRemoveComplete?.(key);
    },
    [onRemoveComplete],
  );

  // Calculate stagger delays for batch entries
  const getStaggerDelay = useCallback(
    (key: string): number => {
      const appearedAt = seenKeys.current.get(key);
      if (!appearedAt) return 0;

      const now = Date.now();
      const age = now - appearedAt;

      // Only stagger items that appeared very recently (within batch window)
      if (age > batchWindow) return 0;

      // Find position among items that appeared in same batch
      const batchItems = Array.from(seenKeys.current.entries())
        .filter(([, time]) => now - time < batchWindow)
        .sort((a, b) => a[1] - b[1]);

      const index = batchItems.findIndex(([k]) => k === key);

      // Cap stagger to prevent extremely long delays
      const cappedIndex = Math.min(index, maxStaggerCount - 1);

      return cappedIndex * staggerInterval;
    },
    [batchWindow, staggerInterval, maxStaggerCount],
  );

  // Check if an item has been seen before (to skip re-animation on viewport re-entry)
  const hasBeenSeen = useCallback((key: string): boolean => {
    return viewedKeys.current.has(key);
  }, []);

  // Mark all current items as seen (call after initial load animations)
  const markAllAsSeen = useCallback(() => {
    for (const item of items) {
      viewedKeys.current.add(getKey(item));
    }
    setIsInitialLoad(false);
  }, [items, getKey]);

  return {
    animatedItems,
    handleExitComplete,
    getStaggerDelay,
    hasBeenSeen,
    markAllAsSeen,
    isInitialLoad,
  };
}
