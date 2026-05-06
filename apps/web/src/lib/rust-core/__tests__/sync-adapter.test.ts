import { describe, expect, it, vi } from 'vitest';
import { InMemoryAlbumSyncSnapshotPersistence, RustSyncAdapter } from '../sync-adapter';
import type {
  AlbumSyncInitInput,
  AlbumSyncSnapshot,
  SyncAdapterPort,
  SyncEffect,
  SyncEvent,
} from '../upload-adapter-port';

const initInput: AlbumSyncInitInput = {
  albumId: '018f0000-0000-7000-8000-000000000302',
  requestId: '018f0000-0000-7000-8000-000000000303',
  startCursor: '',
  nowUnixMs: 0n,
  maxRetryCount: 4,
};

function snapshot(phase: string, cursor = ''): AlbumSyncSnapshot {
  return {
    schemaVersion: 1,
    albumId: initInput.albumId,
    phase,
    activeCursor: cursor,
    pendingCursor: '',
    rerunRequested: false,
    retryCount: 0,
    maxRetryCount: initInput.maxRetryCount,
    nextRetryUnixMs: 0n,
    lastErrorCode: 0,
    lastErrorStage: '',
    updatedAtUnixMs: initInput.nowUnixMs,
  };
}

class FakeSyncPort implements SyncAdapterPort {
  readonly initSync = vi.fn(async (_input: AlbumSyncInitInput): Promise<AlbumSyncSnapshot> => snapshot('Idle'));
  readonly advanceSync = vi.fn(async (_snapshot: AlbumSyncSnapshot, event: SyncEvent): Promise<AlbumSyncSnapshot> =>
    snapshot('FetchingPage', event.nextCursor ?? 'cursor-a'));
  readonly getCurrentEffect = vi.fn((current: AlbumSyncSnapshot): SyncEffect | null =>
    current.phase === 'FetchingPage' ? { kind: 'FetchPage', cursor: current.activeCursor } : null);
}

class FailingSyncPersistence extends InMemoryAlbumSyncSnapshotPersistence {
  override async put(_current: AlbumSyncSnapshot): Promise<void> {
    throw new Error('sync persistence failed');
  }
}

describe('RustSyncAdapter', () => {
  it('start() persists initial snapshot', async () => {
    const port = new FakeSyncPort();
    const persistence = new InMemoryAlbumSyncSnapshotPersistence();
    const adapter = new RustSyncAdapter(port, persistence);

    const result = await adapter.start(initInput);

    await expect(persistence.get(initInput.albumId)).resolves.toEqual(result.snapshot);
    expect(result.effects).toEqual([]);
    expect(port.initSync).toHaveBeenCalledWith(initInput);
  });

  it('submit() advances state and emits effect', async () => {
    const port = new FakeSyncPort();
    const adapter = new RustSyncAdapter(port, new InMemoryAlbumSyncSnapshotPersistence());
    await adapter.start(initInput);

    const result = await adapter.submit({ kind: 'SyncRequested', nextCursor: 'cursor-b' });

    expect(result.snapshot.phase).toBe('FetchingPage');
    expect(result.effects).toEqual([{ kind: 'FetchPage', cursor: 'cursor-b' }]);
    expect(port.advanceSync).toHaveBeenCalledOnce();
  });

  it('resume() loads from persistence', async () => {
    const port = new FakeSyncPort();
    const persistence = new InMemoryAlbumSyncSnapshotPersistence();
    const resumed = snapshot('FetchingPage', 'cursor-c');
    await persistence.put(resumed);
    const adapter = new RustSyncAdapter(port, persistence);

    const result = await adapter.resume(initInput.albumId);

    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected resumed snapshot');
    expect(result.snapshot).toEqual(resumed);
    expect(result.effects).toEqual([{ kind: 'FetchPage', cursor: 'cursor-c' }]);
  });

  it('resume() returns null when persistence has no snapshot', async () => {
    const adapter = new RustSyncAdapter(new FakeSyncPort(), new InMemoryAlbumSyncSnapshotPersistence());

    await expect(adapter.resume(initInput.albumId)).resolves.toBeNull();
    await expect(adapter.submit({ kind: 'SyncRequested' })).rejects.toThrow('Adapter not started');
  });

  it('submit() fails when adapter not started', async () => {
    const adapter = new RustSyncAdapter(new FakeSyncPort(), new InMemoryAlbumSyncSnapshotPersistence());

    await expect(adapter.submit({ kind: 'SyncRequested' })).rejects.toThrow('Adapter not started');
  });

  it('persistence write failure surfaces correctly', async () => {
    const adapter = new RustSyncAdapter(new FakeSyncPort(), new FailingSyncPersistence());

    await expect(adapter.start(initInput)).rejects.toThrow('sync persistence failed');
  });
});
