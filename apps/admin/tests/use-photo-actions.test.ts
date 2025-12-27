/**
 * usePhotoActions Hook Tests
 *
 * Tests for photo deletion functionality including single and bulk delete.
 */

import { act, createElement, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted to create mocks before vi.mock hoisting
const mocks = vi.hoisted(() => ({
  api: {
    deleteManifest: vi.fn(),
  },
  dbClient: {
    deleteManifest: vi.fn(),
  },
  photoService: {
    releasePhoto: vi.fn(),
    releaseThumbnail: vi.fn(),
  },
  coverService: {
    getCachedCover: vi.fn(),
    releaseCover: vi.fn(),
  },
}));

// Mock dependencies
vi.mock('../src/lib/api', () => ({
  getApi: () => mocks.api,
}));

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn().mockResolvedValue(mocks.dbClient),
}));

vi.mock('../src/lib/photo-service', () => ({
  releasePhoto: mocks.photoService.releasePhoto,
  releaseThumbnail: mocks.photoService.releaseThumbnail,
}));

vi.mock('../src/lib/album-cover-service', () => ({
  getCachedCover: mocks.coverService.getCachedCover,
  releaseCover: mocks.coverService.releaseCover,
}));

// Import after mocks are set up
import { PhotoDeleteError, usePhotoActions } from '../src/hooks/usePhotoActions';

// Test component that captures hook result and updates on state changes
function TestComponent({ onResult }: { onResult: (result: ReturnType<typeof usePhotoActions>) => void }) {
  const result = usePhotoActions();
  // Use layout effect to ensure we always have the latest result
  onResult(result);
  return null;
}

// Helper to render hook with proper state tracking
function renderHook() {
  let hookResult: ReturnType<typeof usePhotoActions>;
  let updateTrigger: (() => void) | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);

  // Wrapper component that forces rerenders and captures results
  function Wrapper() {
    const [, setCount] = useState(0);
    updateTrigger = useCallback(() => setCount(c => c + 1), []);
    return createElement(TestComponent, {
      onResult: (result) => { hookResult = result; }
    });
  }

  const root = createRoot(container);
  act(() => {
    root.render(createElement(Wrapper));
  });

  return {
    get result() { return hookResult!; },
    cleanup: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
    rerender: () => {
      act(() => {
        updateTrigger?.();
      });
    }
  };
}

describe('usePhotoActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default mock implementations
    mocks.api.deleteManifest.mockResolvedValue(undefined);
    mocks.dbClient.deleteManifest.mockResolvedValue(undefined);
    mocks.coverService.getCachedCover.mockReturnValue(null);
    
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('deletePhoto', () => {
    it('deletes a single photo successfully', async () => {
      const { result, cleanup } = renderHook();

      await act(async () => {
        await result.deletePhoto('manifest-1', 'album-1');
      });

      expect(mocks.api.deleteManifest).toHaveBeenCalledWith('manifest-1');
      expect(mocks.dbClient.deleteManifest).toHaveBeenCalledWith('manifest-1');
      expect(result.error).toBeNull();
      expect(result.isDeleting).toBe(false);

      cleanup();
    });

    it('handles API errors', async () => {
      mocks.api.deleteManifest.mockRejectedValue(new Error('Server error'));

      const { result, cleanup, rerender } = renderHook();

      let caught = false;
      let caughtError: unknown = null;
      await act(async () => {
        try {
          await result.deletePhoto('manifest-1', 'album-1');
        } catch (e) {
          caught = true;
          caughtError = e;
        }
      });

      expect(caught).toBe(true);
      expect(caughtError).toBeInstanceOf(PhotoDeleteError);
      expect((caughtError as PhotoDeleteError).message).toBe('Server error');

      // After error, isDeleting should be false
      rerender();
      expect(result.isDeleting).toBe(false);

      cleanup();
    });

    it('handles database errors after API success', async () => {
      mocks.dbClient.deleteManifest.mockRejectedValue(new Error('DB error'));

      const { result, cleanup, rerender } = renderHook();

      let caught = false;
      let caughtError: unknown = null;
      await act(async () => {
        try {
          await result.deletePhoto('manifest-1', 'album-1');
        } catch (e) {
          caught = true;
          caughtError = e;
        }
      });

      expect(caught).toBe(true);
      expect(caughtError).toBeInstanceOf(PhotoDeleteError);
      expect((caughtError as PhotoDeleteError).message).toBe('DB error');
      // API was called first
      expect(mocks.api.deleteManifest).toHaveBeenCalled();

      cleanup();
    });

    it('clears error when clearError is called', async () => {
      const { result, cleanup } = renderHook();

      // Test that clearError doesn't throw when no error exists
      act(() => {
        result.clearError();
      });
      expect(result.error).toBeNull();

      cleanup();
    });
  });

  describe('deletePhotos (bulk)', () => {
    it('deletes multiple photos successfully', async () => {
      const { result, cleanup } = renderHook();

      let deleteResult: Awaited<ReturnType<typeof result.deletePhotos>>;

      await act(async () => {
        deleteResult = await result.deletePhotos(
          ['manifest-1', 'manifest-2', 'manifest-3'],
          'album-1'
        );
      });

      expect(mocks.api.deleteManifest).toHaveBeenCalledTimes(3);
      expect(mocks.dbClient.deleteManifest).toHaveBeenCalledTimes(3);
      expect(deleteResult!.successCount).toBe(3);
      expect(deleteResult!.failureCount).toBe(0);
      expect(deleteResult!.failedIds).toHaveLength(0);
      expect(result.error).toBeNull();

      cleanup();
    });

    it('handles partial failures in bulk delete', async () => {
      mocks.api.deleteManifest
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Failed to delete'))
        .mockResolvedValueOnce(undefined);

      const { result, cleanup } = renderHook();

      let deleteResult: Awaited<ReturnType<typeof result.deletePhotos>>;

      await act(async () => {
        deleteResult = await result.deletePhotos(
          ['manifest-1', 'manifest-2', 'manifest-3'],
          'album-1'
        );
      });

      expect(deleteResult!.successCount).toBe(2);
      expect(deleteResult!.failureCount).toBe(1);
      expect(deleteResult!.failedIds).toContain('manifest-2');
      expect(deleteResult!.errors).toHaveLength(1);

      cleanup();
    });

    it('handles complete failure in bulk delete', async () => {
      mocks.api.deleteManifest.mockRejectedValue(new Error('Server down'));

      const { result, cleanup } = renderHook();

      let deleteResult: Awaited<ReturnType<typeof result.deletePhotos>>;

      await act(async () => {
        deleteResult = await result.deletePhotos(
          ['manifest-1', 'manifest-2'],
          'album-1'
        );
      });

      expect(deleteResult!.successCount).toBe(0);
      expect(deleteResult!.failureCount).toBe(2);
      expect(deleteResult!.failedIds).toContain('manifest-1');
      expect(deleteResult!.failedIds).toContain('manifest-2');

      cleanup();
    });

    it('returns empty result for empty input', async () => {
      const { result, cleanup } = renderHook();

      let deleteResult: Awaited<ReturnType<typeof result.deletePhotos>>;

      await act(async () => {
        deleteResult = await result.deletePhotos([], 'album-1');
      });

      expect(mocks.api.deleteManifest).not.toHaveBeenCalled();
      expect(deleteResult!.successCount).toBe(0);
      expect(deleteResult!.failureCount).toBe(0);

      cleanup();
    });
  });

  describe('cache cleanup', () => {
    it('cleans up photo cache after successful deletion', async () => {
      const { result, cleanup } = renderHook();

      await act(async () => {
        await result.deletePhoto('photo-123', 'album-1');
      });

      expect(mocks.photoService.releasePhoto).toHaveBeenCalledWith('photo-123');
      expect(mocks.photoService.releasePhoto).toHaveBeenCalledWith('photo-123:full');
      expect(mocks.photoService.releaseThumbnail).toHaveBeenCalledWith('photo-123');

      cleanup();
    });

    it('releases album cover if deleted photo was the cover', async () => {
      mocks.coverService.getCachedCover.mockReturnValue({
        photoId: 'photo-123',
        blobUrl: 'blob:test',
        mimeType: 'image/jpeg',
      });

      const { result, cleanup } = renderHook();

      await act(async () => {
        await result.deletePhoto('photo-123', 'album-1');
      });

      expect(mocks.coverService.releaseCover).toHaveBeenCalledWith('album-1');

      cleanup();
    });
  });
});
