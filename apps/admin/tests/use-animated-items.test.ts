/**
 * Tests for useAnimatedItems hook
 *
 * Verifies:
 * - New item detection and animation state
 * - Exit animation with phantom entries
 * - Stagger delay calculation
 * - Initial load detection
 * - Viewport re-entry (no re-animation)
 */

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAnimatedItems,
  type UseAnimatedItemsReturn,
} from '../src/hooks/useAnimatedItems';

interface TestItem {
  id: string;
  name: string;
}

// Helper to test hook in a component context
function createHookTester<T>(
  initialItems: T[],
  options: Parameters<typeof useAnimatedItems<T>>[1],
) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let hookResult: UseAnimatedItemsReturn<T> | null = null;
  let setItems: ((items: T[]) => void) | null = null;

  function TestComponent({ items: initialItemsProps }: { items: T[] }) {
    const [itemsState, setItemsState] = useState(initialItemsProps);
    setItems = setItemsState;
    hookResult = useAnimatedItems(itemsState, options);
    return null;
  }

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(TestComponent, { items: initialItems }));
  });

  const getResult = () => hookResult!;

  const updateItems = (newItems: T[]) => {
    act(() => {
      setItems!(newItems);
    });
  };

  const cleanup = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  return { getResult, updateItems, cleanup };
}

describe('useAnimatedItems', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return empty array for empty input', () => {
    const { getResult, cleanup } = createHookTester<TestItem>([], {
      getKey: (item) => item.id,
    });

    expect(getResult().animatedItems).toEqual([]);
    cleanup();
  });

  it('should wrap items with animation state', () => {
    const items: TestItem[] = [
      { id: '1', name: 'Photo 1' },
      { id: '2', name: 'Photo 2' },
    ];

    const { getResult, cleanup } = createHookTester(items, {
      getKey: (item) => item.id,
    });

    expect(getResult().animatedItems).toHaveLength(2);
    expect(getResult().animatedItems[0]).toMatchObject({
      key: '1',
      isExiting: false,
    });
    expect(getResult().animatedItems[1]).toMatchObject({
      key: '2',
      isExiting: false,
    });
    cleanup();
  });

  it('should mark initial items as seen to skip enter animation', () => {
    const items: TestItem[] = [{ id: '1', name: 'Photo 1' }];

    const { getResult, cleanup } = createHookTester(items, {
      getKey: (item) => item.id,
    });

    // On initial render, items should be marked as seen
    expect(getResult().hasBeenSeen('1')).toBe(true);
    cleanup();
  });

  it('should detect new items added after initial render', () => {
    const initialItems: TestItem[] = [{ id: '1', name: 'Photo 1' }];

    const { getResult, updateItems, cleanup } = createHookTester(initialItems, {
      getKey: (item) => item.id,
    });

    // Initial render - item 1 is seen
    expect(getResult().hasBeenSeen('1')).toBe(true);

    // Advance time past initial load
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Add new item
    const newItems: TestItem[] = [
      { id: '1', name: 'Photo 1' },
      { id: '2', name: 'Photo 2' },
    ];

    updateItems(newItems);

    // New item should not be marked as seen yet
    expect(getResult().animatedItems).toHaveLength(2);
    expect(getResult().hasBeenSeen('2')).toBe(false);
    cleanup();
  });

  it('should create phantom entries for removed items', () => {
    const initialItems: TestItem[] = [
      { id: '1', name: 'Photo 1' },
      { id: '2', name: 'Photo 2' },
    ];

    const { getResult, updateItems, cleanup } = createHookTester(initialItems, {
      getKey: (item) => item.id,
    });

    expect(getResult().animatedItems).toHaveLength(2);

    // Remove item 2
    const reducedItems: TestItem[] = [{ id: '1', name: 'Photo 1' }];

    updateItems(reducedItems);

    // Should have phantom entry for removed item
    expect(getResult().animatedItems).toHaveLength(2);
    const exitingItem = getResult().animatedItems.find((a) => a.key === '2');
    expect(exitingItem?.isExiting).toBe(true);
    cleanup();
  });

  it('should remove phantom entry after exit complete callback', () => {
    const initialItems: TestItem[] = [
      { id: '1', name: 'Photo 1' },
      { id: '2', name: 'Photo 2' },
    ];

    const onRemoveComplete = vi.fn();

    const { getResult, updateItems, cleanup } = createHookTester(initialItems, {
      getKey: (item) => item.id,
      onRemoveComplete,
    });

    // Remove item 2
    updateItems([{ id: '1', name: 'Photo 1' }]);

    // Phantom entry exists
    expect(getResult().animatedItems).toHaveLength(2);

    // Call exit complete
    act(() => {
      getResult().handleExitComplete('2');
    });

    // Phantom entry should be removed
    expect(getResult().animatedItems).toHaveLength(1);
    expect(onRemoveComplete).toHaveBeenCalledWith('2');
    cleanup();
  });

  it('should calculate stagger delays for batch additions', () => {
    const { getResult, updateItems, cleanup } = createHookTester<TestItem>([], {
      getKey: (item) => item.id,
      staggerInterval: 50,
      batchWindow: 100,
    });

    // Wait past initial load
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Add batch of items
    const batchItems: TestItem[] = [
      { id: '1', name: 'Photo 1' },
      { id: '2', name: 'Photo 2' },
      { id: '3', name: 'Photo 3' },
    ];

    updateItems(batchItems);

    // Items added in same batch should have staggered delays
    const delay1 = getResult().getStaggerDelay('1');
    const delay2 = getResult().getStaggerDelay('2');
    const delay3 = getResult().getStaggerDelay('3');

    // All should be non-negative
    expect(delay1).toBeGreaterThanOrEqual(0);
    expect(delay2).toBeGreaterThanOrEqual(0);
    expect(delay3).toBeGreaterThanOrEqual(0);
    cleanup();
  });

  it('should return zero stagger delay for old items', () => {
    const items: TestItem[] = [{ id: '1', name: 'Photo 1' }];

    const { getResult, cleanup } = createHookTester(items, {
      getKey: (item) => item.id,
      batchWindow: 100,
    });

    // Advance time past batch window
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Old items should have no stagger delay
    expect(getResult().getStaggerDelay('1')).toBe(0);
    cleanup();
  });

  it('should detect initial load state', () => {
    const items: TestItem[] = [{ id: '1', name: 'Photo 1' }];

    const { getResult, cleanup } = createHookTester(items, {
      getKey: (item) => item.id,
    });

    // Initially should be in loading state
    expect(getResult().isInitialLoad).toBe(true);

    // After timeout, should no longer be initial load
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(getResult().isInitialLoad).toBe(false);
    cleanup();
  });

  it('should markAllAsSeen prevent re-animation', () => {
    const { getResult, updateItems, cleanup } = createHookTester<TestItem>([], {
      getKey: (item) => item.id,
    });

    // Add items
    const items: TestItem[] = [
      { id: '1', name: 'Photo 1' },
      { id: '2', name: 'Photo 2' },
    ];

    updateItems(items);

    // Mark all as seen
    act(() => {
      getResult().markAllAsSeen();
    });

    expect(getResult().hasBeenSeen('1')).toBe(true);
    expect(getResult().hasBeenSeen('2')).toBe(true);
    expect(getResult().isInitialLoad).toBe(false);
    cleanup();
  });

  it('should cap stagger count for performance', () => {
    const { getResult, updateItems, cleanup } = createHookTester<TestItem>([], {
      getKey: (item) => item.id,
      staggerInterval: 50,
      maxStaggerCount: 5,
      batchWindow: 1000, // Large window to include all
    });

    // Wait past initial load
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Add many items at once
    const manyItems: TestItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      name: `Photo ${i}`,
    }));

    updateItems(manyItems);

    // All stagger delays should be capped
    const delays = manyItems.map((item) =>
      getResult().getStaggerDelay(item.id),
    );
    const maxDelay = Math.max(...delays);

    // Max delay should be (maxStaggerCount - 1) * staggerInterval = 4 * 50 = 200
    expect(maxDelay).toBeLessThanOrEqual(200);
    cleanup();
  });

  it('should handle rapid successive updates', () => {
    const initialItems: TestItem[] = [{ id: '1', name: 'Photo 1' }];

    const { getResult, updateItems, cleanup } = createHookTester(initialItems, {
      getKey: (item) => item.id,
    });

    // Rapid updates
    updateItems([...initialItems, { id: '2', name: 'Photo 2' }]);
    updateItems([
      ...initialItems,
      { id: '2', name: 'Photo 2' },
      { id: '3', name: 'Photo 3' },
    ]);
    updateItems([
      { id: '1', name: 'Photo 1' },
      { id: '3', name: 'Photo 3' },
    ]); // Remove 2

    // Should handle gracefully
    expect(getResult().animatedItems.length).toBeGreaterThanOrEqual(2);

    // Item 2 should be exiting
    const item2 = getResult().animatedItems.find((a) => a.key === '2');
    expect(item2?.isExiting).toBe(true);
    cleanup();
  });
});
