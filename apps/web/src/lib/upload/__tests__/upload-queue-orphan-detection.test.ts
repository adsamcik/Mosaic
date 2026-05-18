import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../legacy-drainer', () => ({
  legacyUploadQueueDrainer: {
    drain: vi.fn().mockResolvedValue({ migrated: [] }),
  },
  createUuidV7: vi.fn(() => 'uuid-stub'),
  createIdempotencyKey: vi.fn(() => 'idem-stub'),
}));

import { UploadQueue } from '../upload-queue';
import type { PersistedTask } from '../types';

// Minimal in-memory persistence stub. Mirrors only the methods that
// UploadQueue.initialize / detectAndFlagOrphans actually call so we can
// exercise the orphan detection without spinning up IndexedDB.
function makeStubPersistence(initial: PersistedTask[]) {
  const store = new Map<string, PersistedTask>();
  for (const task of initial) store.set(task.id, { ...task });
  return {
    isInitialized: true,
    init: vi.fn().mockResolvedValue(undefined),
    getAllTasks: vi.fn().mockImplementation(async () => Array.from(store.values())),
    getPendingTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockImplementation(async (id: string, updates: Partial<PersistedTask>) => {
      const task = store.get(id);
      if (task) store.set(id, { ...task, ...updates });
    }),
    saveTask: vi.fn(),
    deleteTask: vi.fn(),
    getContentHashDedupDb: vi.fn().mockReturnValue(undefined),
    store,
  };
}

function makePersistedTask(id: string, status: string): PersistedTask {
  return {
    id,
    albumId: 'album-1',
    fileName: `${id}.jpg`,
    fileSize: 1024,
    epochId: 0,
    totalChunks: 1,
    completedShards: [],
    status,
    retryCount: 0,
    lastAttemptAt: 0,
  };
}

describe('UploadQueue orphan detection (v1.0.x s49-y1)', () => {
  let received: Array<{ id: string; albumId: string; fileName: string; fileSize: number }>;
  let listener: (e: Event) => void;

  beforeEach(() => {
    received = [];
    listener = (e: Event): void => {
      const detail = (e as CustomEvent<{ tasks: typeof received }>).detail;
      received.push(...detail.tasks);
    };
    window.addEventListener('mosaic:upload-needs-reattach', listener);
  });

  afterEach(() => {
    window.removeEventListener('mosaic:upload-needs-reattach', listener);
  });

  it('flags tasks left in `uploading` or `queued` as `needs_reattach` on init', async () => {
    const persistence = makeStubPersistence([
      makePersistedTask('t-uploading', 'uploading'),
      makePersistedTask('t-queued', 'queued'),
      makePersistedTask('t-complete', 'complete'),
      makePersistedTask('t-permfail', 'permanently_failed'),
    ]);
    const queue = new UploadQueue();
    (queue as unknown as { persistence: typeof persistence }).persistence = persistence;

    await queue.init();

    const orphans = await queue.getOrphanedTasks();
    const ids = orphans.map((t) => t.id).sort();
    expect(ids).toEqual(['t-queued', 't-uploading']);
    expect(persistence.store.get('t-uploading')!.status).toBe('needs_reattach');
    expect(persistence.store.get('t-queued')!.status).toBe('needs_reattach');
    expect(persistence.store.get('t-complete')!.status).toBe('complete');
    expect(persistence.store.get('t-permfail')!.status).toBe('permanently_failed');

    queue.dispose();
  });

  it('broadcasts a `mosaic:upload-needs-reattach` event with task metadata', async () => {
    const persistence = makeStubPersistence([
      makePersistedTask('t-1', 'uploading'),
    ]);
    const queue = new UploadQueue();
    (queue as unknown as { persistence: typeof persistence }).persistence = persistence;

    await queue.init();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: 't-1',
      albumId: 'album-1',
      fileName: 't-1.jpg',
      fileSize: 1024,
    });
    queue.dispose();
  });

  it('does not broadcast when no orphans exist', async () => {
    const persistence = makeStubPersistence([
      makePersistedTask('t-complete', 'complete'),
    ]);
    const queue = new UploadQueue();
    (queue as unknown as { persistence: typeof persistence }).persistence = persistence;

    await queue.init();

    expect(received).toHaveLength(0);
    queue.dispose();
  });

  it('is idempotent: tasks already in `needs_reattach` stay flagged but are not re-updated', async () => {
    const persistence = makeStubPersistence([
      makePersistedTask('t-keep', 'needs_reattach'),
    ]);
    const queue = new UploadQueue();
    (queue as unknown as { persistence: typeof persistence }).persistence = persistence;

    await queue.init();

    expect(persistence.updateTask).not.toHaveBeenCalled();
    const orphans = await queue.getOrphanedTasks();
    expect(orphans.map((t) => t.id)).toEqual(['t-keep']);
    queue.dispose();
  });
});
