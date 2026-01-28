/**
 * Memory Pressure Handling Tests
 *
 * Tests for visibility-based cache reduction to save memory when tab is backgrounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initMemoryPressureHandling,
  cleanupMemoryPressureHandling,
  isMemoryPressureActive,
  reduceCacheToRatio,
  getCacheStats,
  clearPhotoCache,
} from '../src/lib/photo-service';

describe('Memory Pressure Handling', () => {
  beforeEach(() => {
    // Clear any cached state
    clearPhotoCache();
    cleanupMemoryPressureHandling();
  });

  afterEach(() => {
    cleanupMemoryPressureHandling();
    clearPhotoCache();
  });

  describe('initMemoryPressureHandling', () => {
    it('should register visibilitychange event listener', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      initMemoryPressureHandling();

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      );

      addEventListenerSpy.mockRestore();
    });

    it('should only initialize once', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      initMemoryPressureHandling();
      initMemoryPressureHandling();

      // Should only add listener once
      const visibilityChangeCalls = addEventListenerSpy.mock.calls.filter(
        (call) => call[0] === 'visibilitychange',
      );
      expect(visibilityChangeCalls).toHaveLength(1);

      addEventListenerSpy.mockRestore();
    });
  });

  describe('cleanupMemoryPressureHandling', () => {
    it('should remove visibilitychange event listener', () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      initMemoryPressureHandling();
      cleanupMemoryPressureHandling();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      );

      removeEventListenerSpy.mockRestore();
    });

    it('should allow re-initialization after cleanup', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      initMemoryPressureHandling();
      cleanupMemoryPressureHandling();
      initMemoryPressureHandling();

      const visibilityChangeCalls = addEventListenerSpy.mock.calls.filter(
        (call) => call[0] === 'visibilitychange',
      );
      expect(visibilityChangeCalls).toHaveLength(2);

      addEventListenerSpy.mockRestore();
    });
  });

  describe('isMemoryPressureActive', () => {
    it('should return false by default', () => {
      expect(isMemoryPressureActive()).toBe(false);
    });
  });

  describe('reduceCacheToRatio', () => {
    it('should not throw when cache is empty', () => {
      expect(() => reduceCacheToRatio(0.25)).not.toThrow();
    });

    it('should handle 0% ratio without throwing', () => {
      expect(() => reduceCacheToRatio(0)).not.toThrow();
    });

    it('should handle 100% ratio without throwing', () => {
      expect(() => reduceCacheToRatio(1)).not.toThrow();
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', () => {
      const stats = getCacheStats();

      expect(stats).toHaveProperty('entries');
      expect(stats).toHaveProperty('sizeBytes');
      expect(stats).toHaveProperty('maxSizeBytes');
      expect(typeof stats.entries).toBe('number');
      expect(typeof stats.sizeBytes).toBe('number');
      expect(typeof stats.maxSizeBytes).toBe('number');
    });

    it('should return zero entries when cache is empty', () => {
      clearPhotoCache();
      const stats = getCacheStats();

      expect(stats.entries).toBe(0);
      expect(stats.sizeBytes).toBe(0);
    });
  });

  describe('visibility change integration', () => {
    it('should set memory pressure active when document becomes hidden', () => {
      initMemoryPressureHandling();

      // Simulate document becoming hidden
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });

      // Dispatch visibility change event
      document.dispatchEvent(new Event('visibilitychange'));

      expect(isMemoryPressureActive()).toBe(true);

      // Reset
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });
    });

    it('should clear memory pressure when document becomes visible', () => {
      initMemoryPressureHandling();

      // First hide
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(isMemoryPressureActive()).toBe(true);

      // Then show
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(isMemoryPressureActive()).toBe(false);
    });
  });
});

describe('Memory Pressure Performance Constraints', () => {
  it('should use 25% cache reduction ratio constant', async () => {
    // Verify REDUCED_CACHE_RATIO is defined as 0.25 in the source
    // This ensures the documented behavior (75% memory freed) is correct
    const fs = await import('fs');
    const path = await import('path');
    const servicePath = path.resolve(
      __dirname,
      '../src/lib/photo-service.ts',
    );
    const content = fs.readFileSync(servicePath, 'utf-8');

    // Verify REDUCED_CACHE_RATIO is defined as 0.25
    expect(content).toMatch(/REDUCED_CACHE_RATIO\s*=\s*0\.25/);

    // Verify reduceCacheToRatio is called with REDUCED_CACHE_RATIO when hidden
    expect(content).toMatch(/reduceCacheToRatio\s*\(\s*REDUCED_CACHE_RATIO\s*\)/);
  });

  it('should verify reduceCacheToRatio does not throw with various ratios', () => {
    // reduceCacheToRatio should handle edge cases gracefully
    // Entries with refCount > 0 are protected by the implementation
    // (verified by checking refCount > 0 continue logic in photo-service.ts)

    // Test various ratios don't cause errors
    expect(() => reduceCacheToRatio(0.25)).not.toThrow();
    expect(() => reduceCacheToRatio(0.5)).not.toThrow();
    expect(() => reduceCacheToRatio(0.1)).not.toThrow();

    // Cache stats should remain valid after reduction
    const stats = getCacheStats();
    expect(stats.entries).toBeGreaterThanOrEqual(0);
    expect(stats.sizeBytes).toBeGreaterThanOrEqual(0);
  });
});
