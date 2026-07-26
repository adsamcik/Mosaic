import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transferHandlers: new Map(),
}));

vi.mock('fts5-sql-bundle', () => ({
  default: vi.fn(async () => ({
    Database: class Database {
      close() {}
      run() {}
      exec() { return []; }
      export() { return new Uint8Array([1, 2, 3]); }
      prepare() {
        return { run() {}, free() {} };
      }
    },
  })),
}));

import {
  DbWorker,
  DbWorkerErrorCode,
} from '../src/workers/db.worker';

describe('DbWorker failure handling', () => {
  /**
   * Slice 8: the DB worker no longer accepts raw key bytes. Tests pass
   * a stub `DbCryptoBridge` whose wrap/unwrap behave like an XOR
   * pass-through — sufficient to exercise the worker's persistence
   * codepaths without booting the real crypto worker.
   */
  function makeBridgeStub() {
    return {
      wrap: vi.fn(async (plaintext: Uint8Array) => plaintext),
      unwrap: vi.fn(async (wrapped: Uint8Array) => wrapped),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rebuilds an unreadable cache after replay security authenticates', async () => {
    const worker = new DbWorker();
    const internalWorker = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      decryptBlob: (data: Uint8Array) => Promise<Uint8Array>;
      runMigrations: () => Promise<void>;
      saveToOPFS: () => Promise<void>;
    };

    vi.spyOn(internalWorker, 'loadFromOPFS').mockResolvedValue(
      new Uint8Array([1, 2, 3, 4]),
    );
    vi.spyOn(internalWorker, 'decryptBlob').mockRejectedValue(
      new Error('authentication failed'),
    );

    const migrationSpy = vi
      .spyOn(internalWorker, 'runMigrations')
      .mockResolvedValue(undefined);
    const saveSpy = vi
      .spyOn(internalWorker, 'saveToOPFS')
      .mockResolvedValue(undefined);

    await expect(worker.init(makeBridgeStub())).resolves.toBeUndefined();
    expect(migrationSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    await expect(worker.getAlbumVersion('album-1')).resolves.toBe(0);
  });

  it('requires init before resetStorage can recreate the database', async () => {
    const worker = new DbWorker();

    await expect(worker.resetStorage()).rejects.toMatchObject({
      code: DbWorkerErrorCode.NOT_INITIALIZED,
    });
  });
});
