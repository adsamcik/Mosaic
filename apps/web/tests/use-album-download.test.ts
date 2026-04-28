/**
 * useAlbumDownload Hook Tests
 *
 * Tests for album download hook — verifies correct service calls,
 * argument passing, signal handling, cancellation, and state management.
 *
 * State observation uses committed DOM output (data attributes) rather
 * than mutable refs to work reliably with React 19 + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlbumDownloadProgress } from '../src/lib/album-download-service';
import type { PhotoMeta } from '../src/workers/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  downloadAlbumAsZip: vi.fn<[unknown], Promise<void>>(),
  supportsFileSystemAccess: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/lib/album-download-service', () => ({
  downloadAlbumAsZip: mocks.downloadAlbumAsZip,
  supportsFileSystemAccess: mocks.supportsFileSystemAccess,
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  useAlbumDownload,
  type UseAlbumDownloadResult,
} from '../src/hooks/useAlbumDownload';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * Renders the hook inside a component that writes state to the DOM
 * via data attributes. Reading committed DOM is more reliable than
 * mutable refs for React 19 async state batching in happy-dom.
 */
function renderHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let latestResult: UseAlbumDownloadResult;

  function HookHost() {
    const hookResult = useAlbumDownload();
    latestResult = hookResult;

    return createElement('div', {
      'data-testid': 'hook-state',
      'data-downloading': String(hookResult.isDownloading),
      'data-has-error': String(hookResult.error !== null),
      'data-error-message': hookResult.error?.message ?? '',
      'data-has-progress': String(hookResult.progress !== null),
      'data-progress-phase': hookResult.progress?.phase ?? '',
      'data-progress-file': hookResult.progress?.currentFileName ?? '',
      'data-supports-streaming': String(hookResult.supportsStreaming),
    });
  }

  const root = createRoot(container);
  act(() => {
    root.render(createElement(HookHost));
  });

  function readState() {
    const el = container.querySelector('[data-testid="hook-state"]')!;
    return {
      isDownloading: el.getAttribute('data-downloading') === 'true',
      hasError: el.getAttribute('data-has-error') === 'true',
      errorMessage: el.getAttribute('data-error-message') ?? '',
      hasProgress: el.getAttribute('data-has-progress') === 'true',
      progressPhase: el.getAttribute('data-progress-phase') ?? '',
      progressFile: el.getAttribute('data-progress-file') ?? '',
      supportsStreaming: el.getAttribute('data-supports-streaming') === 'true',
    };
  }

  return {
    readState,
    get methods() {
      return latestResult!;
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function createMockPhoto(id = 'photo-1'): PhotoMeta {
  return {
    id,
    assetId: `asset-${id}`,
    albumId: 'album-1',
    filename: `${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    shardIds: [`thumb-${id}`, `preview-${id}`, `original-${id}`],
    epochId: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAlbumDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadAlbumAsZip.mockResolvedValue(undefined);
    mocks.supportsFileSystemAccess.mockReturnValue(false);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('starts with isDownloading false, no error, no progress', () => {
      const { readState, cleanup } = renderHook();
      const state = readState();

      expect(state.isDownloading).toBe(false);
      expect(state.hasError).toBe(false);
      expect(state.hasProgress).toBe(false);
      cleanup();
    });

    it('supportsStreaming is false in happy-dom', () => {
      const { readState, cleanup } = renderHook();
      expect(readState().supportsStreaming).toBe(false);
      cleanup();
    });

    it('supportsStreaming reflects supportsFileSystemAccess', () => {
      mocks.supportsFileSystemAccess.mockReturnValue(true);
      const { readState, cleanup } = renderHook();
      expect(readState().supportsStreaming).toBe(true);
      cleanup();
    });
  });

  describe('startDownload', () => {
    it('calls downloadAlbumAsZip with correct arguments', async () => {
      const photos = [createMockPhoto('p1'), createMockPhoto('p2')];
      const { methods, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'My Album', photos);
      });
      await flush();

      expect(mocks.downloadAlbumAsZip).toHaveBeenCalledTimes(1);
      const callArg = mocks.downloadAlbumAsZip.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.albumId).toBe('album-1');
      expect(callArg.albumName).toBe('My Album');
      expect(callArg.photos).toBe(photos);
      expect(typeof callArg.onProgress).toBe('function');
      expect(callArg.signal).toBeInstanceOf(AbortSignal);
      cleanup();
    });

    it('sets isDownloading to false after completion', async () => {
      const { methods, readState, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      expect(readState().isDownloading).toBe(false);
      cleanup();
    });

    it('passes a non-aborted AbortSignal to the service', async () => {
      const { methods, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      const callArg = mocks.downloadAlbumAsZip.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.signal).toBeInstanceOf(AbortSignal);
      expect((callArg.signal as AbortSignal).aborted).toBe(false);
      cleanup();
    });

    it('passes a custom resolver to the service for alternate download sources', async () => {
      const { methods, cleanup } = renderHook();
      const resolver = vi.fn(async () => new Uint8Array([1, 2, 3]));

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()], resolver);
      });
      await flush();

      const callArg = mocks.downloadAlbumAsZip.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.resolveOriginal).toBe(resolver);
      cleanup();
    });
  });

  describe('progress updates', () => {
    it('updates progress state when onProgress callback is invoked', async () => {
      mocks.downloadAlbumAsZip.mockImplementation(async (opts: unknown) => {
        const { onProgress } = opts as { onProgress?: (p: AlbumDownloadProgress) => void };
        onProgress?.({
          phase: 'downloading',
          currentFileName: 'sunset.jpg',
          completedFiles: 1,
          totalFiles: 3,
        });
      });

      const { methods, readState, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      const state = readState();
      expect(state.hasProgress).toBe(true);
      expect(state.progressPhase).toBe('downloading');
      expect(state.progressFile).toBe('sunset.jpg');
      cleanup();
    });
  });

  describe('error handling', () => {
    it('sets error state when downloadAlbumAsZip throws', async () => {
      mocks.downloadAlbumAsZip.mockRejectedValue(new Error('Network failure'));

      const { methods, readState, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      const state = readState();
      expect(state.hasError).toBe(true);
      expect(state.errorMessage).toBe('Network failure');
      expect(state.isDownloading).toBe(false);
      cleanup();
    });

    it('wraps non-Error throws into an Error', async () => {
      mocks.downloadAlbumAsZip.mockRejectedValue('string error');

      const { methods, readState, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      const state = readState();
      expect(state.hasError).toBe(true);
      expect(state.errorMessage).toBe('string error');
      cleanup();
    });

    it('does NOT set error for AbortError (user cancellation)', async () => {
      mocks.downloadAlbumAsZip.mockRejectedValue(
        new DOMException('aborted', 'AbortError'),
      );

      const { methods, readState, cleanup } = renderHook();

      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      expect(readState().hasError).toBe(false);
      cleanup();
    });
  });

  describe('cancel', () => {
    it('aborts the AbortController signal', async () => {
      let capturedSignal: AbortSignal | undefined;

      mocks.downloadAlbumAsZip.mockImplementation(async (opts: unknown) => {
        const { signal } = opts as { signal?: AbortSignal };
        capturedSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });

      const { methods, readState, cleanup } = renderHook();

      // Start download (won't resolve until cancelled)
      act(() => {
        methods.startDownload('album-1', 'Album', [createMockPhoto()]);
      });
      await flush();

      // Cancel
      act(() => {
        methods.cancel();
      });
      await flush();

      expect(capturedSignal?.aborted).toBe(true);
      expect(readState().isDownloading).toBe(false);
      expect(readState().hasError).toBe(false);
      cleanup();
    });

    it('is safe to call when not downloading', () => {
      const { methods, readState, cleanup } = renderHook();

      act(() => {
        methods.cancel();
      });

      expect(readState().isDownloading).toBe(false);
      cleanup();
    });
  });
});
