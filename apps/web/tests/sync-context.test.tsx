/**
 * SyncContext Tests
 * Tests for background auto-sync functionality
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SyncProvider,
  useSyncContext,
  useAutoSync,
} from '../src/contexts/SyncContext';
import { useEffect } from 'react';

// Mock settings service
let mockAutoSyncEnabled = true;
const mockSettingsSubscribers: Array<
  (settings: { autoSync: boolean }) => void
> = [];

vi.mock('../src/lib/settings-service', () => ({
  getSettings: vi.fn(() => ({ autoSync: mockAutoSyncEnabled })),
  subscribeToSettings: vi.fn(
    (callback: (settings: { autoSync: boolean }) => void) => {
      mockSettingsSubscribers.push(callback);
      return () => {
        const index = mockSettingsSubscribers.indexOf(callback);
        if (index >= 0) mockSettingsSubscribers.splice(index, 1);
      };
    },
  ),
}));

// Mock sync engine - use vi.fn() directly in mock factory
vi.mock('../src/lib/sync-engine', () => ({
  syncEngine: {
    sync: vi.fn().mockResolvedValue(undefined),
    isSyncing: false,
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
}));

// Import the mocked module to get access to the mock
import { syncEngine } from '../src/lib/sync-engine';

// Mock API — export real ApiError so `instanceof` checks work inside SyncContext
const mockGetAlbum = vi.fn().mockResolvedValue({
  id: 'album-1',
  currentEpochId: 1,
});

vi.mock('../src/lib/api', () => {
  class ApiError extends Error {
    public readonly status: number;
    public readonly statusText: string;
    public readonly body?: string;
    constructor(status: number, statusText: string, body?: string) {
      super(`API Error ${status}: ${statusText}`);
      this.name = 'ApiError';
      this.status = status;
      this.statusText = statusText;
      this.body = body;
    }
  }
  return {
    ApiError,
    getApi: vi.fn(() => ({
      getAlbum: mockGetAlbum,
    })),
  };
});

// Re-import ApiError from the mocked module so we construct the same class
import { ApiError } from '../src/lib/api';

// Mock epoch key service
vi.mock('../src/lib/epoch-key-service', () => ({
  getOrFetchEpochKey: vi.fn().mockResolvedValue({
    epochId: 1,
    epochSeed: new Uint8Array(32),
    signKeypair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    },
  }),
}));

// Mock epoch key store
const mockClearAlbumKeys = vi.fn();
vi.mock('../src/lib/epoch-key-store', () => ({
  clearAlbumKeys: (...args: unknown[]) => mockClearAlbumKeys(...args),
}));

// Mock db-client
const mockClearAlbumPhotos = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn().mockResolvedValue({
    clearAlbumPhotos: (...args: unknown[]) => mockClearAlbumPhotos(...args),
  }),
}));

// Helper component to access context
function TestConsumer({
  onContext,
}: {
  onContext: (ctx: ReturnType<typeof useSyncContext>) => void;
}) {
  const context = useSyncContext();
  useEffect(() => {
    onContext(context);
  }, [context, onContext]);
  return null;
}

// Helper component to test useAutoSync
function TestAutoSyncConsumer({ albumId }: { albumId: string }) {
  useAutoSync(albumId);
  return createElement('div', { 'data-testid': 'auto-sync-consumer' });
}

describe('SyncContext', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockAutoSyncEnabled = true;
    mockSettingsSubscribers.length = 0;
    mockGetAlbum.mockResolvedValue({
      id: 'album-1',
      currentEpochId: 1,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.useRealTimers();
  });

  describe('SyncProvider', () => {
    it('should provide sync context to children', () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.autoSyncEnabled).toBe(true);
      expect(capturedContext!.syncingAlbums).toBeInstanceOf(Set);
      expect(capturedContext!.lastSyncTime).toBeInstanceOf(Map);
      expect(typeof capturedContext!.triggerSync).toBe('function');
      expect(typeof capturedContext!.registerAlbum).toBe('function');
      expect(typeof capturedContext!.unregisterAlbum).toBe('function');
    });

    it('should update autoSyncEnabled when settings change', () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      expect(capturedContext!.autoSyncEnabled).toBe(true);

      // Simulate settings change
      act(() => {
        mockSettingsSubscribers.forEach((cb) => cb({ autoSync: false }));
      });

      expect(capturedContext!.autoSyncEnabled).toBe(false);
    });

    it('should sync registered albums on interval when autoSync is enabled', async () => {
      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestAutoSyncConsumer, { albumId: 'album-1' }),
          ),
        );
      });

      // Initial state - no sync yet
      expect(syncEngine.sync).not.toHaveBeenCalled();

      // Advance timer past the sync interval (60 seconds)
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      // Should have synced the registered album
      expect(syncEngine.sync).toHaveBeenCalledWith(
        'album-1',
        expect.any(Uint8Array),
      );
    });

    it('should not sync when autoSync is disabled', async () => {
      mockAutoSyncEnabled = false;

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestAutoSyncConsumer, { albumId: 'album-1' }),
          ),
        );
      });

      // Advance timer past the sync interval
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      // Should not have synced
      expect(syncEngine.sync).not.toHaveBeenCalled();
    });

    it('should stop syncing when autoSync is disabled via settings', async () => {
      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestAutoSyncConsumer, { albumId: 'album-1' }),
          ),
        );
      });

      // Advance timer - should sync
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(syncEngine.sync).toHaveBeenCalledTimes(1);

      // Disable autoSync
      act(() => {
        mockSettingsSubscribers.forEach((cb) => cb({ autoSync: false }));
      });

      // Advance timer again - should NOT sync
      vi.mocked(syncEngine.sync).mockClear();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(syncEngine.sync).not.toHaveBeenCalled();
    });
  });

  describe('useAutoSync', () => {
    it('should register album on mount and unregister on unmount', () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Track registered albums via context
      const RegisteredAlbumTracker = () => {
        const context = useSyncContext();
        capturedContext = context;
        return createElement(TestAutoSyncConsumer, { albumId: 'album-test' });
      };

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(RegisteredAlbumTracker),
          ),
        );
      });

      // Album should be registered (we can't directly check the ref, but can trigger sync)
      expect(capturedContext).not.toBeNull();

      // Unmount should unregister
      act(() => {
        root.unmount();
      });
    });
  });

  describe('triggerSync', () => {
    it('should manually sync an album', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      // Trigger manual sync
      await act(async () => {
        await capturedContext!.triggerSync('album-manual');
      });

      expect(syncEngine.sync).toHaveBeenCalledWith(
        'album-manual',
        expect.any(Uint8Array),
      );
    });

    it('should prevent duplicate sync operations for the same album (race condition fix)', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Make sync take some time to complete
      let resolveSync: (() => void) | null = null;
      vi.mocked(syncEngine.sync).mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveSync = resolve;
        });
      });

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      // Trigger multiple syncs simultaneously for the same album
      // This simulates the race condition: rapid clicks or auto-sync + manual trigger
      let sync1Done = false;
      let sync2Done = false;
      let sync3Done = false;

      act(() => {
        // Fire all three sync calls without awaiting - simulating rapid succession
        void capturedContext!.triggerSync('album-race').then(() => {
          sync1Done = true;
        });
        void capturedContext!.triggerSync('album-race').then(() => {
          sync2Done = true;
        });
        void capturedContext!.triggerSync('album-race').then(() => {
          sync3Done = true;
        });
      });

      // The second and third calls should return immediately (already syncing)
      // while the first is still pending
      await act(async () => {
        // Give React time to process the state updates
        await vi.advanceTimersByTimeAsync(10);
      });

      // Sync 2 and 3 should complete immediately (short-circuited by lock)
      expect(sync2Done).toBe(true);
      expect(sync3Done).toBe(true);
      // Sync 1 is still waiting for the promise to resolve
      expect(sync1Done).toBe(false);

      // Now complete the actual sync
      await act(async () => {
        resolveSync?.();
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(sync1Done).toBe(true);

      // Most importantly: sync engine should only be called ONCE
      expect(syncEngine.sync).toHaveBeenCalledTimes(1);
      expect(syncEngine.sync).toHaveBeenCalledWith(
        'album-race',
        expect.any(Uint8Array),
      );
    });

    it('should allow syncing different albums concurrently', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Reset mock to default behavior (resolve immediately)
      vi.mocked(syncEngine.sync).mockResolvedValue(undefined);

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      // Trigger syncs for different albums
      await act(async () => {
        await Promise.all([
          capturedContext!.triggerSync('album-1'),
          capturedContext!.triggerSync('album-2'),
        ]);
      });

      // Both should have been synced
      expect(syncEngine.sync).toHaveBeenCalledTimes(2);
      expect(syncEngine.sync).toHaveBeenCalledWith(
        'album-1',
        expect.any(Uint8Array),
      );
      expect(syncEngine.sync).toHaveBeenCalledWith(
        'album-2',
        expect.any(Uint8Array),
      );
    });
  });

  describe('useSyncContext outside provider', () => {
    it('should throw error when used outside SyncProvider', () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      expect(() => {
        act(() => {
          root = createRoot(container);
          root.render(createElement(TestConsumer, { onContext: () => {} }));
        });
      }).toThrow('useSyncContext must be used within a SyncProvider');

      consoleError.mockRestore();
    });
  });

  describe('404 album cleanup', () => {
    it('handles 404 by cleaning up album data', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Make getAlbum throw a 404 ApiError
      mockGetAlbum.mockRejectedValue(new ApiError(404, 'Not Found'));

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      // Register the album, then trigger sync
      act(() => {
        capturedContext!.registerAlbum('album-gone');
      });

      await act(async () => {
        await capturedContext!.triggerSync('album-gone');
      });

      // Should have cleaned up local data
      expect(mockClearAlbumKeys).toHaveBeenCalledWith('album-gone');
      expect(mockClearAlbumPhotos).toHaveBeenCalledWith('album-gone');
    });

    it('does not clean up on non-404 errors', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Make getAlbum throw a 500 ApiError
      mockGetAlbum.mockRejectedValue(new ApiError(500, 'Internal Server Error'));

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      await act(async () => {
        await capturedContext!.triggerSync('album-500');
      });

      // Should NOT have cleaned up
      expect(mockClearAlbumKeys).not.toHaveBeenCalled();
      expect(mockClearAlbumPhotos).not.toHaveBeenCalled();
    });

    it('does not clean up on network errors', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Make getAlbum throw a generic (non-API) error
      mockGetAlbum.mockRejectedValue(new Error('Network failure'));

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      await act(async () => {
        await capturedContext!.triggerSync('album-offline');
      });

      // Should NOT have cleaned up — not an ApiError
      expect(mockClearAlbumKeys).not.toHaveBeenCalled();
      expect(mockClearAlbumPhotos).not.toHaveBeenCalled();
    });

    it('handles cleanup errors gracefully', async () => {
      let capturedContext: ReturnType<typeof useSyncContext> | null = null;

      // Make getAlbum throw a 404 AND make cleanup throw
      mockGetAlbum.mockRejectedValue(new ApiError(404, 'Not Found'));
      mockClearAlbumKeys.mockImplementation(() => {
        throw new Error('IndexedDB is broken');
      });

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(
            SyncProvider,
            null,
            createElement(TestConsumer, {
              onContext: (ctx) => {
                capturedContext = ctx;
              },
            }),
          ),
        );
      });

      // Should not throw — the error is caught internally
      await act(async () => {
        await capturedContext!.triggerSync('album-broken');
      });

      // clearAlbumKeys was attempted
      expect(mockClearAlbumKeys).toHaveBeenCalledWith('album-broken');
      // clearAlbumPhotos was NOT reached because clearAlbumKeys threw first
    });
  });
});
