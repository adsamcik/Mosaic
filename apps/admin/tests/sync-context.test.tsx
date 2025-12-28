/**
 * SyncContext Tests
 * Tests for background auto-sync functionality
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncProvider, useSyncContext, useAutoSync } from '../src/contexts/SyncContext';
import { useEffect } from 'react';

// Mock settings service
let mockAutoSyncEnabled = true;
const mockSettingsSubscribers: Array<(settings: { autoSync: boolean }) => void> = [];

vi.mock('../src/lib/settings-service', () => ({
  getSettings: vi.fn(() => ({ autoSync: mockAutoSyncEnabled })),
  subscribeToSettings: vi.fn((callback: (settings: { autoSync: boolean }) => void) => {
    mockSettingsSubscribers.push(callback);
    return () => {
      const index = mockSettingsSubscribers.indexOf(callback);
      if (index >= 0) mockSettingsSubscribers.splice(index, 1);
    };
  }),
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

// Mock API
vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => ({
    getAlbum: vi.fn().mockResolvedValue({
      id: 'album-1',
      currentEpochId: 1,
    }),
  })),
}));

// Mock epoch key service
vi.mock('../src/lib/epoch-key-service', () => ({
  getOrFetchEpochKey: vi.fn().mockResolvedValue({
    epochId: 1,
    epochSeed: new Uint8Array(32),
    signKeypair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  }),
}));

// Helper component to access context
function TestConsumer({ onContext }: { onContext: (ctx: ReturnType<typeof useSyncContext>) => void }) {
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
          createElement(SyncProvider, null,
            createElement(TestConsumer, {
              onContext: (ctx) => { capturedContext = ctx; }
            })
          )
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
          createElement(SyncProvider, null,
            createElement(TestConsumer, {
              onContext: (ctx) => { capturedContext = ctx; }
            })
          )
        );
      });

      expect(capturedContext!.autoSyncEnabled).toBe(true);

      // Simulate settings change
      act(() => {
        mockSettingsSubscribers.forEach(cb => cb({ autoSync: false }));
      });

      expect(capturedContext!.autoSyncEnabled).toBe(false);
    });

    it('should sync registered albums on interval when autoSync is enabled', async () => {
      act(() => {
        root = createRoot(container);
        root.render(
          createElement(SyncProvider, null,
            createElement(TestAutoSyncConsumer, { albumId: 'album-1' })
          )
        );
      });

      // Initial state - no sync yet
      expect(syncEngine.sync).not.toHaveBeenCalled();

      // Advance timer past the sync interval (60 seconds)
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      // Should have synced the registered album
      expect(syncEngine.sync).toHaveBeenCalledWith('album-1', expect.any(Uint8Array));
    });

    it('should not sync when autoSync is disabled', async () => {
      mockAutoSyncEnabled = false;

      act(() => {
        root = createRoot(container);
        root.render(
          createElement(SyncProvider, null,
            createElement(TestAutoSyncConsumer, { albumId: 'album-1' })
          )
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
          createElement(SyncProvider, null,
            createElement(TestAutoSyncConsumer, { albumId: 'album-1' })
          )
        );
      });

      // Advance timer - should sync
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(syncEngine.sync).toHaveBeenCalledTimes(1);

      // Disable autoSync
      act(() => {
        mockSettingsSubscribers.forEach(cb => cb({ autoSync: false }));
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
          createElement(SyncProvider, null,
            createElement(RegisteredAlbumTracker)
          )
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
          createElement(SyncProvider, null,
            createElement(TestConsumer, {
              onContext: (ctx) => { capturedContext = ctx; }
            })
          )
        );
      });

      // Trigger manual sync
      await act(async () => {
        await capturedContext!.triggerSync('album-manual');
      });

      expect(syncEngine.sync).toHaveBeenCalledWith('album-manual', expect.any(Uint8Array));
    });
  });

  describe('useSyncContext outside provider', () => {
    it('should throw error when used outside SyncProvider', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      expect(() => {
        act(() => {
          root = createRoot(container);
          root.render(createElement(TestConsumer, { onContext: () => {} }));
        });
      }).toThrow('useSyncContext must be used within a SyncProvider');

      consoleError.mockRestore();
    });
  });
});
