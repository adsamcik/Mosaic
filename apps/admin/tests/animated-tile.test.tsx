/**
 * Tests for AnimatedTile component
 *
 * Verifies:
 * - Animation phase transitions
 * - CSS class application
 * - Stagger delay handling
 * - Skip animation flag
 * - Exit animation and callback
 * - Reduced motion support
 */

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimatedTile, usePrefersReducedMotion } from '../src/components/Gallery/AnimatedTile';

describe('AnimatedTile', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    container.remove();
  });

  const render = (element: React.ReactElement) => {
    act(() => {
      root = createRoot(container);
      root.render(element);
    });
  };

  it('should render children', () => {
    render(
      createElement(AnimatedTile, { itemKey: 'test-1' },
        createElement('div', { 'data-testid': 'child' }, 'Content')
      )
    );

    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('Content');
  });

  it('should apply tile-enter class for new items', () => {
    const now = Date.now();

    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        appearedAt: now,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.className).toContain('animated-tile');
    expect(tile?.className).toContain('tile-enter');
  });

  it('should transition to tile-enter-active after frame delay', () => {
    const now = Date.now();

    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        appearedAt: now,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    // Advance past the animation frame
    act(() => {
      vi.advanceTimersByTime(50);
    });

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.className).toContain('tile-enter-active');
  });

  it('should skip animation for items marked as seen', () => {
    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        hasBeenSeen: true,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.className).toContain('tile-enter-active');
    expect(tile?.className).not.toContain('tile-enter ');
  });

  it('should skip animation when skipAnimation is true', () => {
    const now = Date.now();

    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        appearedAt: now,
        skipAnimation: true,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.className).toContain('tile-enter-active');
  });

  it('should apply stagger delay as CSS variable', () => {
    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        staggerDelay: 150,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]') as HTMLElement;
    expect(tile?.style.getPropertyValue('--stagger-delay')).toBe('150ms');
  });

  it('should apply tile-exit classes when isExiting', () => {
    let setExiting: ((val: boolean) => void) | null = null;

    function TestWrapper() {
      const [isExiting, setIsExiting] = useState(false);
      setExiting = setIsExiting;
      return createElement(AnimatedTile, {
        itemKey: 'test-1',
        skipAnimation: true,
        isExiting,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      );
    }

    render(createElement(TestWrapper));

    // Start exit
    act(() => {
      setExiting!(true);
    });

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.className).toContain('tile-exit');
  });

  it('should call onExitComplete after exit animation', () => {
    const onExitComplete = vi.fn();
    let setExiting: ((val: boolean) => void) | null = null;

    function TestWrapper() {
      const [isExiting, setIsExiting] = useState(false);
      setExiting = setIsExiting;
      return createElement(AnimatedTile, {
        itemKey: 'test-1',
        skipAnimation: true,
        isExiting,
        onExitComplete,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      );
    }

    render(createElement(TestWrapper));

    act(() => {
      setExiting!(true);
    });

    // Wait for exit duration (200ms)
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });

  it('should not render after exit animation completes', () => {
    let setExiting: ((val: boolean) => void) | null = null;

    function TestWrapper() {
      const [isExiting, setIsExiting] = useState(false);
      setExiting = setIsExiting;
      return createElement(AnimatedTile, {
        itemKey: 'test-1',
        skipAnimation: true,
        isExiting,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      );
    }

    render(createElement(TestWrapper));

    expect(container.querySelector('[data-testid="tile"]')).not.toBeNull();

    act(() => {
      setExiting!(true);
    });

    // Wait for exit animation
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector('[data-testid="tile"]')).toBeNull();
  });

  it('should add animation-settled class after animation completes', () => {
    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        skipAnimation: true,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');

    // Should be settled immediately when skipAnimation is true
    expect(tile?.className).toContain('animation-settled');
  });

  it('should apply data-item-key attribute', () => {
    render(
      createElement(AnimatedTile, {
        itemKey: 'my-unique-key',
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.getAttribute('data-item-key')).toBe('my-unique-key');
  });

  it('should apply data-animation-phase attribute', () => {
    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        skipAnimation: true,
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.getAttribute('data-animation-phase')).toBe('entered');
  });

  it('should merge additional className', () => {
    render(
      createElement(AnimatedTile, {
        itemKey: 'test-1',
        className: 'custom-class another-class',
        'data-testid': 'tile',
      },
        createElement('div', null, 'Content')
      )
    );

    const tile = container.querySelector('[data-testid="tile"]');
    expect(tile?.className).toContain('custom-class');
    expect(tile?.className).toContain('another-class');
    expect(tile?.className).toContain('animated-tile');
  });
});

describe('usePrefersReducedMotion', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let listeners: Array<(e: MediaQueryListEvent) => void>;

  beforeEach(() => {
    listeners = [];
    mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn((event: string, listener: (e: MediaQueryListEvent) => void) => {
        listeners.push(listener);
      }),
      removeEventListener: vi.fn(),
    }));
    window.matchMedia = mockMatchMedia as unknown as typeof window.matchMedia;

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    container.remove();
  });

  it('should return false when motion is not reduced', () => {
    let result = false;

    function TestComponent() {
      result = usePrefersReducedMotion();
      return null;
    }

    act(() => {
      root = createRoot(container);
      root.render(createElement(TestComponent));
    });

    expect(result).toBe(false);
  });

  it('should return true when motion is reduced', () => {
    mockMatchMedia.mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    let result = false;

    function TestComponent() {
      result = usePrefersReducedMotion();
      return null;
    }

    act(() => {
      root = createRoot(container);
      root.render(createElement(TestComponent));
    });

    expect(result).toBe(true);
  });
});
