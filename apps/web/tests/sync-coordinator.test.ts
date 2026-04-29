/**
 * Tests for the SyncCoordinator's content-conflict forwarding path.
 *
 * The coordinator already has end-to-end coverage via `sync-context.test.tsx`
 * for the photo-sync side. This file focuses on the new
 * `onContentConflict` listener seam introduced by Lane B for the album
 * content (story blocks) conflict-resolution flow described in
 * `docs/specs/SPEC-SyncConflictResolution.md`.
 *
 * The tests use the real `syncEngine` instance (it is just an
 * EventTarget under the hood) and a stub PhotoStore so they can run
 * without the worker/database stack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mocks (must be hoisted before importing the coordinator)
// =============================================================================

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../src/lib/photo-query-pagination', () => ({
  loadAllAlbumPhotos: vi.fn(() => Promise.resolve([])),
}));

const photoStoreState = {
  initAlbum: vi.fn(),
  albums: new Map(),
  getPhoto: vi.fn(),
  markUploadFailed: vi.fn(),
  promoteToStable: vi.fn(),
  addStableFromServer: vi.fn(),
  confirmDeleted: vi.fn(),
  updatePhotoFromServer: vi.fn(),
};

vi.mock('../src/stores/photo-store', () => ({
  usePhotoStore: {
    getState: () => photoStoreState,
  },
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    startTimer: () => ({ end: vi.fn() }),
  }),
}));

// =============================================================================
// Imports under test
// =============================================================================

import { syncCoordinator } from '../src/lib/sync-coordinator';
import { syncEngine, type ContentConflictEventDetail } from '../src/lib/sync-engine';

// =============================================================================
// Helpers
// =============================================================================

function makeConflictDetail(
  override: Partial<ContentConflictEventDetail> = {},
): ContentConflictEventDetail {
  return {
    albumId: 'album-1',
    strategy: 'three-way-block-merge',
    manualConflictCount: 1,
    totalDecisionCount: 3,
    manualConflictBlockIds: ['block-x'],
    ...override,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('SyncCoordinator content-conflict forwarding', () => {
  beforeEach(() => {
    // The coordinator is a process-wide singleton; the test suite for
    // SyncContext does not call `init()` on it, so most tests can rely
    // on a fresh state. We dispose() before each test to wipe listeners
    // and timers from prior suites.
    syncCoordinator.dispose();
    syncCoordinator.init();
  });

  afterEach(() => {
    syncCoordinator.dispose();
  });

  it('forwards content-conflict events from the syncEngine to subscribers', () => {
    const listener = vi.fn();
    const dispose = syncCoordinator.onContentConflict(listener);

    const detail = makeConflictDetail();
    syncEngine.notifyContentConflict(detail);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(detail);

    dispose();
  });

  it('removes listeners when their dispose function is called', () => {
    const listener = vi.fn();
    const dispose = syncCoordinator.onContentConflict(listener);

    dispose();
    syncEngine.notifyContentConflict(makeConflictDetail());

    expect(listener).not.toHaveBeenCalled();
  });

  it('dispatches to multiple listeners independently', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const disposeA = syncCoordinator.onContentConflict(listenerA);
    const disposeB = syncCoordinator.onContentConflict(listenerB);

    const detail = makeConflictDetail({ albumId: 'album-2' });
    syncEngine.notifyContentConflict(detail);

    expect(listenerA).toHaveBeenCalledWith(detail);
    expect(listenerB).toHaveBeenCalledWith(detail);

    disposeA();
    disposeB();
  });

  it('continues to dispatch when a single listener throws', () => {
    const throwing = vi.fn(() => {
      throw new Error('listener failure');
    });
    const healthy = vi.fn();

    const d1 = syncCoordinator.onContentConflict(throwing);
    const d2 = syncCoordinator.onContentConflict(healthy);

    syncEngine.notifyContentConflict(makeConflictDetail());

    expect(throwing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();

    d1();
    d2();
  });

  it('stops forwarding after dispose() is called', () => {
    const listener = vi.fn();
    syncCoordinator.onContentConflict(listener);

    syncCoordinator.dispose();
    syncEngine.notifyContentConflict(makeConflictDetail());

    expect(listener).not.toHaveBeenCalled();
  });

  it('payload contains only opaque ids and resolution counts', () => {
    const listener = vi.fn();
    syncCoordinator.onContentConflict(listener);

    const detail = makeConflictDetail({
      manualConflictBlockIds: ['blk_1', 'blk_2'],
    });
    syncEngine.notifyContentConflict(detail);

    expect(listener).toHaveBeenCalledTimes(1);
    const received = listener.mock.calls[0]?.[0] as ContentConflictEventDetail;

    // Sanity check that no key material or plaintext-block fields snuck in.
    const allowedKeys = [
      'albumId',
      'strategy',
      'manualConflictCount',
      'totalDecisionCount',
      'manualConflictBlockIds',
    ];
    expect(Object.keys(received).sort()).toEqual(allowedKeys.sort());
    for (const id of received.manualConflictBlockIds) {
      expect(typeof id).toBe('string');
    }
  });
});
