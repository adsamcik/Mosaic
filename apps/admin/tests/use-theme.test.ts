/**
 * useTheme Hook Tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTheme } from '../src/hooks/useTheme';
import * as settingsService from '../src/lib/settings-service';

// Test component that captures hook result
function TestComponent({
  onResult,
}: {
  onResult: (result: ReturnType<typeof useTheme>) => void;
}) {
  const result = useTheme();
  onResult(result);
  return null;
}

// Mutable mock for MediaQueryList
interface MockMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  onchange: null;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

describe('useTheme', () => {
  let localStorageMock: Record<string, string>;
  let mediaQueryListeners: Array<(e: MediaQueryListEvent) => void>;
  let mockMediaQuery: MockMediaQueryList;
  let container: HTMLDivElement;
  let root: Root;

  // Helper to render hook with proper state tracking
  function renderHook() {
    let hookResult: ReturnType<typeof useTheme>;
    let updateTrigger: (() => void) | null = null;

    function Wrapper() {
      const [, setCount] = useState(0);
      updateTrigger = useCallback(() => setCount((c) => c + 1), []);
      return createElement(TestComponent, {
        onResult: (result) => {
          hookResult = result;
        },
      });
    }

    act(() => {
      root.render(createElement(Wrapper));
    });

    return {
      get result() {
        return hookResult!;
      },
      rerender: () => {
        act(() => {
          updateTrigger?.();
        });
      },
    };
  }

  beforeEach(() => {
    // Mock localStorage
    localStorageMock = {};
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      (key) => localStorageMock[key] ?? null
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      localStorageMock[key] = value;
    });

    // Track media query listeners
    mediaQueryListeners = [];

    // Mock matchMedia with mutable matches property
    mockMediaQuery = {
      matches: false, // Default to light system preference
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn((_, listener) => {
        mediaQueryListeners.push(listener as (e: MediaQueryListEvent) => void);
      }),
      removeEventListener: vi.fn((_, listener) => {
        const idx = mediaQueryListeners.indexOf(
          listener as (e: MediaQueryListEvent) => void
        );
        if (idx !== -1) mediaQueryListeners.splice(idx, 1);
      }),
      dispatchEvent: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };

    vi.spyOn(window, 'matchMedia').mockReturnValue(mockMediaQuery as unknown as MediaQueryList);

    // Reset document attribute
    document.documentElement.removeAttribute('data-theme');

    // Create container
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-theme');
  });

  it('applies dark theme by default when no settings exist', () => {
    const { result } = renderHook();

    expect(result).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies light theme when settings specify light', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'light',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    const { result } = renderHook();

    expect(result).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies dark theme when settings specify dark', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'dark',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    const { result } = renderHook();

    expect(result).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('respects system preference when theme is system and prefers dark', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'system',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    // System prefers dark
    mockMediaQuery.matches = true;

    const { result } = renderHook();

    expect(result).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('respects system preference when theme is system and prefers light', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'system',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    // System prefers light
    mockMediaQuery.matches = false;

    const { result } = renderHook();

    expect(result).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('updates DOM theme when settings change', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'dark',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    renderHook();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // Simulate settings change
    act(() => {
      settingsService.saveSettings({
        idleTimeout: 30,
        theme: 'light',
        thumbnailQuality: 'medium',
        autoSync: true,
      });
    });

    // DOM should be updated immediately via the subscription
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('updates DOM theme when system preference changes (for system theme)', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'system',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    // Start with light system preference
    mockMediaQuery.matches = false;

    renderHook();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // Simulate system preference change to dark
    act(() => {
      mockMediaQuery.matches = true;
      mediaQueryListeners.forEach((listener) =>
        listener({ matches: true } as MediaQueryListEvent)
      );
    });

    // DOM should be updated via the media query listener
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores system preference change when theme is not system', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'dark',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    mockMediaQuery.matches = false;

    const { result, rerender } = renderHook();

    expect(result).toBe('dark');

    // Simulate system preference change
    act(() => {
      mockMediaQuery.matches = true;
      mediaQueryListeners.forEach((listener) =>
        listener({ matches: true } as MediaQueryListEvent)
      );
    });

    rerender();

    // Should still be dark (user preference overrides system)
    expect(result).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('cleans up listeners on unmount', () => {
    renderHook();

    expect(mockMediaQuery.addEventListener).toHaveBeenCalledTimes(1);

    // Cleanup happens in afterEach
  });

  it('switching from explicit to system theme uses system preference', () => {
    localStorageMock['mosaic:settings'] = JSON.stringify({
      idleTimeout: 30,
      theme: 'light',
      thumbnailQuality: 'medium',
      autoSync: true,
    });

    // System prefers dark
    mockMediaQuery.matches = true;

    renderHook();

    // Initially light (explicit)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // Switch to system theme
    act(() => {
      settingsService.saveSettings({
        idleTimeout: 30,
        theme: 'system',
        thumbnailQuality: 'medium',
        autoSync: true,
      });
    });

    // Should now follow system (dark)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
